const http = require("http");
const https = require("https");

const TELEGRAM_TOKEN = "8474626291:AAHStCYEfsDn9DbRh2YGK4-00hlyoF7_cRs";
const FIREBASE_PROJECT = "inventario---novo";
const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Firebase Web API Key
const FIREBASE_API_KEY = "AIzaSyAvCXDCLnRtR7KmL2pefE-fP_yAMGDkNvI";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ── FIRESTORE REST API ──
async function firestoreGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`${FIRESTORE_BASE}/${path}?key=${FIREBASE_API_KEY}`, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

async function firestoreQuery(collection, filters = []) {
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters.length > 1 ? {
        compositeFilter: {
          op: "AND",
          filters: filters.map(f => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op || "EQUAL",
              value: { stringValue: f.value }
            }
          }))
        }
      } : filters.length === 1 ? {
        fieldFilter: {
          field: { fieldPath: filters[0].field },
          op: filters[0].op || "EQUAL",
          value: { stringValue: filters[0].value }
        }
      } : undefined,
      limit: 200
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${FIRESTORE_BASE}:runQuery?key=${FIREBASE_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      res => {
        let data = "";
        res.on("data", d => data += d);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const docs = parsed.filter(r => r.document).map(r => {
              const fields = r.document.fields || {};
              const id = r.document.name.split("/").pop();
              const obj = { id };
              for (const [k, v] of Object.entries(fields)) {
                obj[k] = v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? v.timestampValue ?? null;
              }
              return obj;
            });
            resolve(docs);
          } catch(e) { resolve([]); }
        });
      }
    );
    req.write(body);
    req.end();
  });
}

async function firestoreAdd(collection, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: String(v) };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
  }
  fields["ts"] = { timestampValue: new Date().toISOString() };

  const body = JSON.stringify({ fields });
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${FIRESTORE_BASE}/${collection}?key=${FIREBASE_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      res => { let d = ""; res.on("data", x => d += x); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.write(body);
    req.end();
  });
}

// ── STOCK CALCULATION ──
async function calcStock(productId, initialStock = 0) {
  const mvs = await firestoreQuery("movimientos", [{ field: "productId", value: productId }]);
  let stock = parseInt(initialStock) || 0;
  mvs.forEach(m => { stock += m.type === "entrada" ? parseInt(m.qty)||0 : -(parseInt(m.qty)||0); });
  return Math.max(0, stock);
}

// ── SEND TELEGRAM MESSAGE ──
async function sendMessage(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  return new Promise(resolve => {
    const req = https.request(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => { res.on("data", resolve); });
    req.write(body);
    req.end();
  });
}

// ── PROCESS MESSAGE ──
async function processMessage(chatId, text) {
  const msg = (text || "").trim().toLowerCase();

  // AYUDA
  if (msg === "/start" || msg === "ayuda" || msg === "/ayuda") {
    return sendMessage(chatId,
      "🤖 <b>Bot Inventario Novo</b>\n\n" +
      "Comandos disponibles:\n\n" +
      "🔍 <b>buscar [nombre]</b>\n" +
      "📊 <b>resumen</b>\n" +
      "🏙️ <b>sede [ciudad]</b>\n" +
      "⚠️ <b>alertas</b>\n\n" +
      "➕ <b>agregar [nombre] · [categoría] · [código]</b>\n" +
      "⬇️ <b>entrada [código] · [cantidad] · [evento]</b>\n" +
      "⬆️ <b>salida [código] · [cantidad] · [destino]</b>\n\n" +
      "Ejemplo: <code>buscar carpa</code>\n" +
      "Ejemplo: <code>entrada NOVO00001 · 2 · Copa Novo</code>"
    );
  }

  // BUSCAR
  if (msg.startsWith("buscar ")) {
    const termino = text.substring(7).trim().toLowerCase();
    const todos = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }]);
    const encontrados = todos.filter(p =>
      (p.name||"").toLowerCase().includes(termino) ||
      (p.barcode||"").toLowerCase().includes(termino)
    );
    if (!encontrados.length) return sendMessage(chatId, `❌ No encontré "<b>${termino}</b>" en bodega Bogotá.`);

    // Group by loteId or id
    const groups = {};
    for (const p of encontrados) {
      const key = (p.esLote && p.loteId) ? p.loteId : p.id;
      if (!groups[key]) groups[key] = { name: p.name, category: p.category, location: p.location, products: [] };
      groups[key].products.push(p);
    }

    let resp = `🔍 <b>Resultados para "${termino}"</b>\n\n`;
    for (const g of Object.values(groups)) {
      let totalStock = 0;
      for (const p of g.products) totalStock += await calcStock(p.id, p.initialStock);
      const esLote = g.products.length > 1;
      resp += `📦 <b>${g.name}</b>${esLote ? ` (${g.products.length} uds · lote)` : ""}\n`;
      resp += `   📍 Ubicación: ${g.location || "—"}\n`;
      resp += `   🏷️ Categoría: ${g.category || "—"}\n`;
      resp += `   📊 Stock: <b>${totalStock} u.</b>\n`;
      if (!esLote) resp += `   📟 Código: <code>${g.products[0].barcode}</code>\n`;
      resp += "\n";
    }
    return sendMessage(chatId, resp);
  }

  // RESUMEN
  if (msg === "resumen" || msg === "/resumen") {
    const prods = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }]);
    const mvs = await firestoreQuery("movimientos", [{ field: "sede", value: "Bogotá" }]);
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const mvsHoy = mvs.filter(m => m.ts && new Date(m.ts) >= hoy);
    const entradas = mvsHoy.filter(m => m.type === "entrada").length;
    const salidas = mvsHoy.filter(m => m.type === "salida" && m.esBaja !== "true").length;
    const bajas = mvsHoy.filter(m => m.esBaja === "true").length;
    return sendMessage(chatId,
      `📊 <b>Resumen Inventario Novo</b>\n` +
      `📅 ${new Date().toLocaleDateString("es-CO",{day:"numeric",month:"long"})}\n\n` +
      `📦 Productos en Bogotá: <b>${prods.length}</b>\n` +
      `⬇️ Entradas hoy: <b>${entradas}</b>\n` +
      `⬆️ Salidas hoy: <b>${salidas}</b>\n` +
      `🔴 Bajas hoy: <b>${bajas}</b>\n\n` +
      `Escribe <code>alertas</code> para ver problemas.`
    );
  }

  // SEDE
  if (msg.startsWith("sede ")) {
    const SEDES = ["Bogotá","Tenjo","Cali","Medellín","Villamaría","Soledad"];
    const buscar = text.substring(5).trim();
    const sedeEncontrada = SEDES.find(s => s.toLowerCase().includes(buscar.toLowerCase()));
    if (!sedeEncontrada) return sendMessage(chatId, `❌ Sede no encontrada.\nSedes: ${SEDES.join(", ")}`);

    const prods = await firestoreQuery("productos", [{ field: "sede", value: sedeEncontrada }]);
    if (!prods.length) return sendMessage(chatId, `📭 No hay productos en <b>${sedeEncontrada}</b>`);

    let resp = `🏙️ <b>Inventario ${sedeEncontrada}</b>\n\n`;
    let total = 0;
    for (const p of prods.slice(0,15)) {
      const stock = await calcStock(p.id, p.initialStock);
      if (stock > 0) { resp += `• ${p.name} — <b>${stock} u.</b>\n`; total += stock; }
    }
    if (prods.length > 15) resp += `\n... y ${prods.length - 15} más`;
    resp += `\n\n📦 Total: <b>${total} unidades</b>`;
    return sendMessage(chatId, resp);
  }

  // ALERTAS
  if (msg === "alertas" || msg === "/alertas") {
    const prods = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }]);
    const sinStock = [], stockBajo = [];
    for (const p of prods) {
      const stock = await calcStock(p.id, p.initialStock);
      if (stock <= 0) sinStock.push(p.name);
      else if (stock <= (parseInt(p.minStock)||1)) stockBajo.push(`${p.name} (${stock} u.)`);
    }
    let resp = `⚠️ <b>Alertas Inventario Novo</b>\n\n`;
    if (sinStock.length) resp += `❌ <b>Sin stock:</b>\n` + sinStock.slice(0,10).map(n=>`• ${n}`).join("\n") + "\n\n";
    if (stockBajo.length) resp += `⚡ <b>Stock bajo:</b>\n` + stockBajo.slice(0,10).map(n=>`• ${n}`).join("\n");
    if (!sinStock.length && !stockBajo.length) resp += "✅ ¡Todo en orden!";
    return sendMessage(chatId, resp);
  }

  // AGREGAR
  if (msg.startsWith("agregar ")) {
    const partes = text.substring(8).split("·").map(p => p.trim());
    if (partes.length < 3) return sendMessage(chatId,
      "❌ Formato: <code>agregar [nombre] · [categoría] · [código]</code>\n" +
      "Ejemplo: <code>agregar Balón Nike · Balones · NOVO00050</code>"
    );
    const [nombre, categoria, codigo] = partes;
    const dup = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }, { field: "barcode", value: codigo }]);
    if (dup.length) return sendMessage(chatId, `❌ El código <code>${codigo}</code> ya existe.`);
    await firestoreAdd("productos", {
      name: nombre, category: categoria, barcode: codigo,
      sede: "Bogotá", initialStock: "0", minStock: "1",
      photo: "", location: "", notes: "Creado desde Telegram",
    });
    return sendMessage(chatId, `✅ <b>Producto creado</b>\n📦 ${nombre}\n🏷️ ${categoria}\n📟 <code>${codigo}</code>`);
  }

  // ENTRADA
  if (msg.startsWith("entrada ")) {
    const partes = text.substring(8).split("·").map(p => p.trim());
    if (partes.length < 2) return sendMessage(chatId, "❌ Formato: <code>entrada [código] · [cantidad] · [evento]</code>");
    const [codigo, cantStr, evento] = partes;
    const qty = parseInt(cantStr) || 0;
    if (!qty) return sendMessage(chatId, "❌ Cantidad inválida.");
    const prods = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }, { field: "barcode", value: codigo }]);
    if (!prods.length) return sendMessage(chatId, `❌ Código <code>${codigo}</code> no encontrado en Bogotá.`);
    const p = prods[0];
    await firestoreAdd("movimientos", {
      productId: p.id, type: "entrada", qty: String(qty),
      event: evento || "", notes: "Desde Telegram",
      sede: "Bogotá", userName: "Admin (bot)",
    });
    const nuevoStock = await calcStock(p.id, p.initialStock);
    return sendMessage(chatId, `⬇️ <b>Entrada registrada</b>\n📦 ${p.name}\n+${qty} u. → Stock: <b>${nuevoStock} u.</b>`);
  }

  // SALIDA
  if (msg.startsWith("salida ")) {
    const partes = text.substring(7).split("·").map(p => p.trim());
    if (partes.length < 2) return sendMessage(chatId, "❌ Formato: <code>salida [código] · [cantidad] · [destino]</code>");
    const [codigo, cantStr, destino] = partes;
    const qty = parseInt(cantStr) || 0;
    if (!qty) return sendMessage(chatId, "❌ Cantidad inválida.");
    const prods = await firestoreQuery("productos", [{ field: "sede", value: "Bogotá" }, { field: "barcode", value: codigo }]);
    if (!prods.length) return sendMessage(chatId, `❌ Código <code>${codigo}</code> no encontrado en Bogotá.`);
    const p = prods[0];
    const stock = await calcStock(p.id, p.initialStock);
    if (qty > stock) return sendMessage(chatId, `❌ Stock insuficiente. Solo hay <b>${stock} u.</b>`);
    await firestoreAdd("movimientos", {
      productId: p.id, type: "salida", qty: String(qty),
      event: destino || "", notes: "Desde Telegram",
      sede: "Bogotá", sedeDest: destino || "", userName: "Admin (bot)",
    });
    const nuevoStock = await calcStock(p.id, p.initialStock);
    return sendMessage(chatId, `⬆️ <b>Salida registrada</b>\n📦 ${p.name}\n-${qty} u.${destino?" → "+destino:""}\nStock restante: <b>${nuevoStock} u.</b>`);
  }

  return sendMessage(chatId, "🤖 No entendí. Escribe <code>ayuda</code> para ver los comandos.");
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        if (update?.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || "";
          await processMessage(chatId, text);
        }
      } catch(e) { console.error(e); }
      res.writeHead(200);
      res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("Bot Inventario Novo funcionando ✅");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
