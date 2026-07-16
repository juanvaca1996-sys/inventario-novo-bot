const http = require("http");
const https = require("https");

const TELEGRAM_TOKEN = "8474626291:AAHStCYEfsDn9DbRh2YGK4-OOhlyoF7_cRs";
const FIREBASE_PROJECT = "inventario---novo";
const FIREBASE_API_KEY = "AIzaSyAvCXDCLnRtR7KmL2pefE-fP_yAMGDkNvI";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── USER STATE (menú) ──
const userState = {};

// ── TELEGRAM HELPERS ──
async function tgPost(method, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(`${API_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => {
      let d = ""; res.on("data", x => d += x);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

// Enviar mensaje con botones inline
async function sendMenu(chatId, text, buttons) {
  return tgPost("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
}

// Enviar mensaje simple
async function send(chatId, text) {
  return tgPost("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

// Editar mensaje existente
async function editMessage(chatId, messageId, text, buttons) {
  return tgPost("editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    reply_markup: buttons ? { inline_keyboard: buttons } : undefined
  });
}

// ── FIRESTORE ──
async function fsQuery(col, filters = []) {
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: col }],
      where: filters.length > 1 ? {
        compositeFilter: { op: "AND", filters: filters.map(f => ({
          fieldFilter: { field: { fieldPath: f.field }, op: "EQUAL", value: { stringValue: f.value } }
        }))}
      } : filters.length === 1 ? {
        fieldFilter: { field: { fieldPath: filters[0].field }, op: "EQUAL", value: { stringValue: filters[0].value } }
      } : undefined,
      limit: 500
    }
  });
  return new Promise((resolve) => {
    const req = https.request(`${FIRESTORE_BASE}:runQuery?key=${FIREBASE_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let d = ""; res.on("data", x => d += x);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(d);
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
    });
    req.write(body); req.end();
  });
}

async function fsAdd(col, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: String(v) };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
  }
  fields["ts"] = { timestampValue: new Date().toISOString() };
  const body = JSON.stringify({ fields });
  return new Promise((resolve) => {
    const req = https.request(`${FIRESTORE_BASE}/${col}?key=${FIREBASE_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => { let d = ""; res.on("data", x => d += x); res.on("end", () => resolve(JSON.parse(d))); });
    req.write(body); req.end();
  });
}

// ── STOCK ──
async function calcStock(productId, initialStock = 0) {
  const mvs = await fsQuery("movimientos", [{ field: "productId", value: productId }]);
  let stock = parseInt(initialStock) || 0;
  mvs.forEach(m => { stock += m.type === "entrada" ? parseInt(m.qty)||0 : -(parseInt(m.qty)||0); });
  return Math.max(0, stock);
}

// ── MENÚ PRINCIPAL ──
async function showMainMenu(chatId, name) {
  userState[chatId] = { action: "menu" };
  return sendMenu(chatId,
    `👋 <b>Hola${name ? " " + name : ""}!</b> Bienvenido al\n🏪 <b>Sistema Inventario Novo</b>\n\n¿Qué deseas hacer?`,
    [
      [{ text: "🔍 Buscar producto", callback_data: "menu_buscar" },
       { text: "📊 Resumen", callback_data: "menu_resumen" }],
      [{ text: "🏙️ Ver sede", callback_data: "menu_sede" },
       { text: "⚠️ Alertas", callback_data: "menu_alertas" }],
      [{ text: "⬇️ Registrar entrada", callback_data: "menu_entrada" },
       { text: "⬆️ Registrar salida", callback_data: "menu_salida" }],
      [{ text: "🌐 Abrir app web", url: "https://inventario---novo.web.app" }]
    ]
  );
}

// ── RESUMEN ──
async function showResumen(chatId) {
  await send(chatId, "⏳ Consultando datos...");
  const prods = await fsQuery("productos", [{ field: "sede", value: "Bogotá" }]);
  const mvs = await fsQuery("movimientos", [{ field: "sede", value: "Bogotá" }]);
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const mvsHoy = mvs.filter(m => m.ts && new Date(m.ts) >= hoy);
  const entradas = mvsHoy.filter(m => m.type === "entrada").length;
  const salidas = mvsHoy.filter(m => m.type === "salida" && m.esBaja !== "true").length;
  const bajas = mvsHoy.filter(m => m.esBaja === "true").length;

  // Group products
  const groups = {};
  for (const p of prods) {
    const key = (p.esLote && p.loteId) ? p.loteId : p.id;
    if (!groups[key]) groups[key] = { products: [] };
    groups[key].products.push(p);
  }

  return sendMenu(chatId,
    `📊 <b>Resumen — ${new Date().toLocaleDateString("es-CO",{day:"numeric",month:"long",year:"numeric"})}</b>\n\n` +
    `📦 Referencias en bodega Bogotá: <b>${Object.keys(groups).length}</b>\n` +
    `🗂️ Unidades totales registradas: <b>${prods.length}</b>\n\n` +
    `<b>Movimientos hoy:</b>\n` +
    `⬇️ Entradas: <b>${entradas}</b>\n` +
    `⬆️ Salidas: <b>${salidas}</b>\n` +
    `🔴 Bajas: <b>${bajas}</b>`,
    [[{ text: "⚠️ Ver alertas", callback_data: "menu_alertas" },
      { text: "🏠 Menú principal", callback_data: "menu_inicio" }]]
  );
}

// ── BUSCAR ──
async function buscarProducto(chatId, termino) {
  await send(chatId, `🔍 Buscando <b>"${termino}"</b>...`);
  const todos = await fsQuery("productos", [{ field: "sede", value: "Bogotá" }]);
  const encontrados = todos.filter(p =>
    (p.name||"").toLowerCase().includes(termino.toLowerCase()) ||
    (p.barcode||"").toLowerCase().includes(termino.toLowerCase())
  );

  if (!encontrados.length) {
    return sendMenu(chatId,
      `❌ No encontré "<b>${termino}</b>" en bodega Bogotá.`,
      [[{ text: "🔍 Buscar otro", callback_data: "menu_buscar" },
        { text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }

  // Group by loteId or id
  const groups = {};
  for (const p of encontrados) {
    const key = (p.esLote && p.loteId) ? p.loteId : p.id;
    if (!groups[key]) groups[key] = { name: p.name, category: p.category, location: p.location, esLote: !!(p.esLote && p.loteId), loteId: p.loteId, products: [] };
    groups[key].products.push(p);
  }

  let resp = `🔍 <b>Resultados para "${termino}"</b>\n`;
  resp += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const g of Object.values(groups)) {
    let totalStock = 0;
    for (const p of g.products) totalStock += await calcStock(p.id, p.initialStock);
    const stockEmoji = totalStock <= 0 ? "🔴" : totalStock <= 2 ? "🟡" : "🟢";

    resp += `📦 <b>${g.name}</b>\n`;
    resp += `🏷️ Categoría: ${g.category || "—"}\n`;
    resp += `📍 Ubicación: <b>${g.location || "—"}</b>\n`;
    resp += `${stockEmoji} Stock Bogotá: <b>${totalStock} u.</b>\n`;

    if (g.esLote) {
      resp += `📋 Lote de <b>${g.products.length} unidades</b>\n`;
      resp += `<b>Códigos del lote:</b>\n`;
      g.products.forEach((p, i) => {
        resp += `  ${i+1}. <code>${p.barcode}</code>\n`;
      });
    } else {
      resp += `📟 Código: <code>${g.products[0].barcode}</code>\n`;
    }
    resp += "\n";
  }

  return sendMenu(chatId, resp,
    [[{ text: "🔍 Buscar otro", callback_data: "menu_buscar" },
      { text: "🏠 Menú", callback_data: "menu_inicio" }]]
  );
}

// ── SEDE ──
async function showSedes(chatId) {
  return sendMenu(chatId, "🏙️ <b>¿Qué sede quieres consultar?</b>",
    [
      [{ text: "📦 Bogotá (Principal)", callback_data: "sede_Bogotá" }],
      [{ text: "🏙️ Cali", callback_data: "sede_Cali" },
       { text: "🏙️ Medellín", callback_data: "sede_Medellín" }],
      [{ text: "🏙️ Tenjo", callback_data: "sede_Tenjo" },
       { text: "🏙️ Villamaría", callback_data: "sede_Villamaría" }],
      [{ text: "🏙️ Soledad", callback_data: "sede_Soledad" }],
      [{ text: "🏠 Menú principal", callback_data: "menu_inicio" }]
    ]
  );
}

async function showSede(chatId, sede) {
  await send(chatId, `⏳ Consultando inventario de <b>${sede}</b>...`);
  const prods = await fsQuery("productos", [{ field: "sede", value: sede }]);
  if (!prods.length) {
    return sendMenu(chatId, `📭 No hay productos registrados en <b>${sede}</b>`,
      [[{ text: "🏙️ Ver otra sede", callback_data: "menu_sede" },
        { text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }

  let resp = `🏙️ <b>Inventario ${sede}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let totalUnidades = 0;
  for (const p of prods.slice(0, 20)) {
    const stock = await calcStock(p.id, p.initialStock);
    if (stock > 0) {
      const emoji = stock <= 2 ? "🟡" : "🟢";
      resp += `${emoji} ${p.name} — <b>${stock} u.</b>\n`;
      totalUnidades += stock;
    }
  }
  if (prods.length > 20) resp += `\n<i>... y ${prods.length - 20} productos más</i>`;
  resp += `\n━━━━━━━━━━━━━━━━━━━━\n📦 Total: <b>${totalUnidades} unidades</b>`;

  return sendMenu(chatId, resp,
    [[{ text: "🏙️ Ver otra sede", callback_data: "menu_sede" },
      { text: "🏠 Menú", callback_data: "menu_inicio" }]]
  );
}

// ── ALERTAS ──
async function showAlertas(chatId) {
  await send(chatId, "⏳ Analizando inventario...");
  const prods = await fsQuery("productos", [{ field: "sede", value: "Bogotá" }]);
  const sinStock = [], stockBajo = [];

  for (const p of prods) {
    const stock = await calcStock(p.id, p.initialStock);
    if (stock <= 0) sinStock.push(p.name);
    else if (stock <= (parseInt(p.minStock)||1)) stockBajo.push(`${p.name} (${stock} u.)`);
  }

  let resp = `⚠️ <b>Alertas Inventario Novo</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (sinStock.length) {
    resp += `❌ <b>Sin stock (${sinStock.length}):</b>\n`;
    sinStock.slice(0,10).forEach(n => resp += `  • ${n}\n`);
    resp += "\n";
  }
  if (stockBajo.length) {
    resp += `🟡 <b>Stock bajo (${stockBajo.length}):</b>\n`;
    stockBajo.slice(0,10).forEach(n => resp += `  • ${n}\n`);
  }
  if (!sinStock.length && !stockBajo.length) resp += "✅ <b>¡Todo en orden!</b>\nNo hay alertas activas.";

  return sendMenu(chatId, resp,
    [[{ text: "📊 Ver resumen", callback_data: "menu_resumen" },
      { text: "🏠 Menú", callback_data: "menu_inicio" }]]
  );
}

// ── ENTRADA ──
async function registrarEntrada(chatId, codigo, qty, evento) {
  const prods = await fsQuery("productos", [{ field: "sede", value: "Bogotá" }, { field: "barcode", value: codigo }]);
  if (!prods.length) {
    return sendMenu(chatId, `❌ Código <code>${codigo}</code> no encontrado en Bogotá.`,
      [[{ text: "🔍 Buscar producto", callback_data: "menu_buscar" },
        { text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }
  const p = prods[0];
  await fsAdd("movimientos", {
    productId: p.id, type: "entrada", qty: String(qty),
    event: evento || "", notes: "Desde Telegram",
    sede: "Bogotá", userName: "Admin (bot)",
  });
  const nuevoStock = await calcStock(p.id, p.initialStock);
  return sendMenu(chatId,
    `✅ <b>Entrada registrada</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 ${p.name}\n` +
    `📟 <code>${p.barcode}</code>\n` +
    `⬇️ Cantidad: <b>+${qty} u.</b>\n` +
    `${evento ? "📅 Evento: " + evento + "\n" : ""}` +
    `📊 Nuevo stock: <b>${nuevoStock} u.</b>`,
    [[{ text: "⬇️ Otra entrada", callback_data: "menu_entrada" },
      { text: "🏠 Menú", callback_data: "menu_inicio" }]]
  );
}

// ── SALIDA ──
async function registrarSalida(chatId, codigo, qty, destino) {
  const prods = await fsQuery("productos", [{ field: "sede", value: "Bogotá" }, { field: "barcode", value: codigo }]);
  if (!prods.length) {
    return sendMenu(chatId, `❌ Código <code>${codigo}</code> no encontrado en Bogotá.`,
      [[{ text: "🔍 Buscar producto", callback_data: "menu_buscar" },
        { text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }
  const p = prods[0];
  const stock = await calcStock(p.id, p.initialStock);
  if (qty > stock) {
    return sendMenu(chatId,
      `❌ <b>Stock insuficiente</b>\n📦 ${p.name}\nDisponible: <b>${stock} u.</b>\nSolicitado: <b>${qty} u.</b>`,
      [[{ text: "⬆️ Intentar de nuevo", callback_data: "menu_salida" },
        { text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }
  await fsAdd("movimientos", {
    productId: p.id, type: "salida", qty: String(qty),
    event: destino || "", notes: "Desde Telegram",
    sede: "Bogotá", sedeDest: destino || "", userName: "Admin (bot)",
  });
  const nuevoStock = await calcStock(p.id, p.initialStock);
  return sendMenu(chatId,
    `✅ <b>Salida registrada</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 ${p.name}\n` +
    `📟 <code>${p.barcode}</code>\n` +
    `⬆️ Cantidad: <b>-${qty} u.</b>\n` +
    `${destino ? "📍 Destino: " + destino + "\n" : ""}` +
    `📊 Stock restante: <b>${nuevoStock} u.</b>`,
    [[{ text: "⬆️ Otra salida", callback_data: "menu_salida" },
      { text: "🏠 Menú", callback_data: "menu_inicio" }]]
  );
}

// ── PROCESS CALLBACK (botones) ──
async function processCallback(chatId, data, messageId, userName) {
  if (data === "menu_inicio") return showMainMenu(chatId, userName);
  if (data === "menu_resumen") return showResumen(chatId);
  if (data === "menu_alertas") return showAlertas(chatId);
  if (data === "menu_sede") return showSedes(chatId);
  if (data.startsWith("sede_")) return showSede(chatId, data.replace("sede_", ""));

  if (data === "menu_buscar") {
    userState[chatId] = { action: "buscar" };
    return sendMenu(chatId, "🔍 <b>Buscar producto</b>\n\nEscribe el nombre o código del producto:",
      [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (data === "menu_entrada") {
    userState[chatId] = { action: "entrada_codigo" };
    return sendMenu(chatId,
      "⬇️ <b>Registrar Entrada</b>\n\nEscribe el <b>código de barras</b> del producto:\n<i>Ejemplo: NOVO00001</i>",
      [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (data === "menu_salida") {
    userState[chatId] = { action: "salida_codigo" };
    return sendMenu(chatId,
      "⬆️ <b>Registrar Salida</b>\n\nEscribe el <b>código de barras</b> del producto:\n<i>Ejemplo: NOVO00001</i>",
      [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (data === "menu_agregar") {
    return sendMenu(chatId,
      "➕ <b>Agregar productos</b>\n\nPara agregar productos con foto, lote y todos los detalles, usa la app web:",
      [[{ text: "🌐 Abrir app web", url: "https://inventario---novo.web.app" }],
       [{ text: "🏠 Menú", callback_data: "menu_inicio" }]]
    );
  }
}

// ── PROCESS MESSAGE ──
async function processMessage(chatId, text, userName) {
  const state = userState[chatId] || {};
  const msg = (text || "").trim();

  // Comandos globales
  if (msg === "/start" || msg.toLowerCase() === "menu" || msg.toLowerCase() === "inicio") {
    return showMainMenu(chatId, userName);
  }
  if (msg === "/menu") return showMainMenu(chatId, userName);

  // Sin estado — mostrar menú
  if (!state.action || state.action === "menu") {
    return showMainMenu(chatId, userName);
  }

  // ── BUSCAR ──
  if (state.action === "buscar") {
    userState[chatId] = { action: "menu" };
    return buscarProducto(chatId, msg);
  }

  // ── ENTRADA ──
  if (state.action === "entrada_codigo") {
    userState[chatId] = { action: "entrada_qty", codigo: msg };
    return sendMenu(chatId,
      `📟 Código: <code>${msg}</code>\n\n⬇️ ¿Cuántas unidades entran?`,
      [[{ text: "1️⃣ 1 u.", callback_data: `eq_1_${msg}` },
        { text: "2️⃣ 2 u.", callback_data: `eq_2_${msg}` },
        { text: "5️⃣ 5 u.", callback_data: `eq_5_${msg}` }],
       [{ text: "🔟 10 u.", callback_data: `eq_10_${msg}` },
        { text: "✏️ Otra cantidad", callback_data: `eq_custom_${msg}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (state.action === "entrada_qty_custom") {
    const qty = parseInt(msg);
    if (!qty || qty <= 0) return send(chatId, "❌ Cantidad inválida. Escribe un número.");
    userState[chatId] = { action: "entrada_evento", codigo: state.codigo, qty };
    return sendMenu(chatId,
      `⬇️ Entrada de <b>${qty} u.</b>\n\n📅 ¿A qué evento corresponde? (o salta)`,
      [[{ text: "⏭️ Sin evento", callback_data: `ee_skip_${state.codigo}_${qty}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (state.action === "entrada_evento") {
    userState[chatId] = { action: "menu" };
    return registrarEntrada(chatId, state.codigo, state.qty, msg);
  }

  // ── SALIDA ──
  if (state.action === "salida_codigo") {
    userState[chatId] = { action: "salida_qty", codigo: msg };
    return sendMenu(chatId,
      `📟 Código: <code>${msg}</code>\n\n⬆️ ¿Cuántas unidades salen?`,
      [[{ text: "1️⃣ 1 u.", callback_data: `sq_1_${msg}` },
        { text: "2️⃣ 2 u.", callback_data: `sq_2_${msg}` },
        { text: "5️⃣ 5 u.", callback_data: `sq_5_${msg}` }],
       [{ text: "🔟 10 u.", callback_data: `sq_10_${msg}` },
        { text: "✏️ Otra cantidad", callback_data: `sq_custom_${msg}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (state.action === "salida_qty_custom") {
    const qty = parseInt(msg);
    if (!qty || qty <= 0) return send(chatId, "❌ Cantidad inválida. Escribe un número.");
    userState[chatId] = { action: "salida_destino", codigo: state.codigo, qty };
    return sendMenu(chatId,
      `⬆️ Salida de <b>${qty} u.</b>\n\n🏙️ ¿A qué sede va o evento?`,
      [[{ text: "📦 Tenjo", callback_data: `sd_Tenjo_${state.codigo}_${qty}` },
        { text: "📦 Cali", callback_data: `sd_Cali_${state.codigo}_${qty}` }],
       [{ text: "📦 Medellín", callback_data: `sd_Medellín_${state.codigo}_${qty}` },
        { text: "📦 Villamaría", callback_data: `sd_Villamaría_${state.codigo}_${qty}` }],
       [{ text: "📦 Soledad", callback_data: `sd_Soledad_${state.codigo}_${qty}` },
        { text: "✏️ Otro destino", callback_data: `sd_custom_${state.codigo}_${qty}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  if (state.action === "salida_destino_custom") {
    userState[chatId] = { action: "menu" };
    return registrarSalida(chatId, state.codigo, state.qty, msg);
  }

  // Agregar solo desde app web

  return showMainMenu(chatId, userName);
}

// ── PROCESS CALLBACK DATA (cantidades y destinos) ──
async function processCallbackData(chatId, data, userName) {
  // Cantidad entrada: eq_N_CODIGO o eq_custom_CODIGO
  if (data.startsWith("eq_")) {
    const parts = data.split("_");
    const qty = parts[1];
    const codigo = parts.slice(2).join("_");
    if (qty === "custom") {
      userState[chatId] = { action: "entrada_qty_custom", codigo };
      return sendMenu(chatId, `✏️ Escribe la cantidad de unidades a ingresar:`,
        [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
      );
    }
    userState[chatId] = { action: "entrada_evento", codigo, qty: parseInt(qty) };
    return sendMenu(chatId,
      `⬇️ Entrada de <b>${qty} u.</b> - <code>${codigo}</code>\n\n📅 ¿Evento? (escribe o salta)`,
      [[{ text: "⏭️ Sin evento", callback_data: `ee_skip_${codigo}_${qty}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  // Skip evento entrada: ee_skip_CODIGO_QTY
  if (data.startsWith("ee_skip_")) {
    const parts = data.replace("ee_skip_", "").split("_");
    const qty = parseInt(parts.pop());
    const codigo = parts.join("_");
    userState[chatId] = { action: "menu" };
    return registrarEntrada(chatId, codigo, qty, "");
  }

  // Cantidad salida: sq_N_CODIGO o sq_custom_CODIGO
  if (data.startsWith("sq_")) {
    const parts = data.split("_");
    const qty = parts[1];
    const codigo = parts.slice(2).join("_");
    if (qty === "custom") {
      userState[chatId] = { action: "salida_qty_custom", codigo };
      return sendMenu(chatId, `✏️ Escribe la cantidad de unidades a sacar:`,
        [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
      );
    }
    userState[chatId] = { action: "salida_destino", codigo, qty: parseInt(qty) };
    return sendMenu(chatId,
      `⬆️ Salida de <b>${qty} u.</b> - <code>${codigo}</code>\n\n🏙️ ¿A qué sede o evento va?`,
      [[{ text: "📦 Tenjo", callback_data: `sd_Tenjo_${codigo}_${qty}` },
        { text: "📦 Cali", callback_data: `sd_Cali_${codigo}_${qty}` }],
       [{ text: "📦 Medellín", callback_data: `sd_Medellín_${codigo}_${qty}` },
        { text: "📦 Villamaría", callback_data: `sd_Villamaría_${codigo}_${qty}` }],
       [{ text: "📦 Soledad", callback_data: `sd_Soledad_${codigo}_${qty}` },
        { text: "✏️ Otro destino", callback_data: `sd_custom_${codigo}_${qty}` }],
       [{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
    );
  }

  // Destino salida: sd_DESTINO_CODIGO_QTY
  if (data.startsWith("sd_")) {
    const parts = data.replace("sd_", "").split("_");
    const qty = parseInt(parts.pop());
    const codigo = parts.pop();
    const destino = parts.join("_");
    if (destino === "custom") {
      userState[chatId] = { action: "salida_destino_custom", codigo, qty };
      return sendMenu(chatId, `✏️ Escribe el destino o evento:`,
        [[{ text: "❌ Cancelar", callback_data: "menu_inicio" }]]
      );
    }
    userState[chatId] = { action: "menu" };
    return registrarSalida(chatId, codigo, qty, destino);
  }


}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        // Mensaje de texto
        if (update?.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || "";
          const userName = update.message.from?.first_name || "";
          await processMessage(chatId, text, userName);
        }
        // Callback de botón
        if (update?.callback_query) {
          const chatId = update.callback_query.message.chat.id;
          const data = update.callback_query.data;
          const userName = update.callback_query.from?.first_name || "";
          const msgId = update.callback_query.message.message_id;
          // Responder al callback para quitar el "cargando"
          await tgPost("answerCallbackQuery", { callback_query_id: update.callback_query.id });
          // Procesar acción
          const handled = await processCallbackData(chatId, data, userName);
          if (!handled) await processCallback(chatId, data, msgId, userName);
        }
      } catch(e) { console.error(e); }
      res.writeHead(200); res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("🤖 Bot Inventario Novo — Online ✅");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Bot Inventario Novo corriendo en puerto ${PORT}`));
