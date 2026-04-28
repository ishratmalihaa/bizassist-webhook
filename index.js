async function ai(sender, msg, products, h) {
  msg = (msg || "").toLowerCase().trim();

  /* ================= SAFETY CHECK ================= */
  if (!Array.isArray(products)) products = [];

  /* ================= GREETING ================= */
  if (/^(hi|hello|hey|halo|helo)$/i.test(msg)) {
    return "👋 Hello! What are you looking for? (product name লিখুন)";
  }

  if (/^(হাই|হ্যালো|আসসালামু আলাইকুম)$/i.test(msg)) {
    return "👋 আসসালামু আলাইকুম! আপনি কি খুঁজছেন?";
  }

  /* ================= INTENT ================= */
  const intent =
    /price|dam|koto/.test(msg) ? "price" :
    /color|rong/.test(msg) ? "color" :
    /stock|available|ache/.test(msg) ? "stock" :
    /order|buy|nibo/.test(msg) ? "order" :
    "general";

  /* ================= ORDER FLOW ================= */
  if (h.awaitingOrder) {
    if (/^(yes|haan|ok|sure|nibo)$/i.test(msg)) {
      const p = h.orderProduct;

      h.awaitingOrder = false;
      h.orderProduct = null;

      if (!p?.product_name) return "⚠️ Product missing";

      return `🛒 Order confirmed: ${p.product_name}`;
    }

    if (/^(no|cancel|na)$/i.test(msg)) {
      h.awaitingOrder = false;
      h.orderProduct = null;
      return "❌ Cancelled";
    }
  }

  /* ================= PRODUCT MATCH ================= */
  let product = findProduct(products, msg);

  const isContextQuestion =
    /\b(ki|eta|this|it|details|about)\b/.test(msg) &&
    /(price|dam|color|rong|stock|available)/.test(msg);

  /* SAFE CONTEXT USE */
  if (!product && isContextQuestion && h.lastProduct?.product_name) {
    product = h.lastProduct;
  }

  /* ================= FINAL FALLBACK (SAFE) ================= */
  if (!product) {
    const list = (products || [])
      .slice(0, 5)
      .map(p => `• ${p?.product_name || "Unknown product"}`)
      .join("\n");

    return `❌ Product পাওয়া যায়নি 😕\n\nAvailable products:\n${list}`;
  }

  /* ================= SAVE CONTEXT ================= */
  h.lastProduct = product;

  const name = product.product_name || "Product";
  const price = product.price_bdt ?? "N/A";
  const color = product.color ?? "N/A";

  /* ================= RESPONSES ================= */
  if (intent === "price") return `${name} price ${price} BDT`;
  if (intent === "color") return `${name} color: ${color}`;

  if (intent === "stock") {
    return product.stock_availability === "in_stock"
      ? `${name} available`
      : `${name} out of stock`;
  }

  if (intent === "order") {
    h.awaitingOrder = true;
    h.orderProduct = product;
    return `Do you want to order ${name}? (yes/no)`;
  }

  /* ================= DEFAULT RESPONSE ================= */
  return `✨ ${name} - ${price} BDT\nAsk: price / color / stock / order`;
}
