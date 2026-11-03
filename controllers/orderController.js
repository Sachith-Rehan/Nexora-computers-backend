import Order from "../models/order.js";
import Product from "../models/product.js";

const transferThreshold = 100000;

function paymentSettings() {
    const { BANK_NAME: bank, BANK_BRANCH: branch, BANK_ACCOUNT_HOLDER: holder,
        BANK_ACCOUNT_NUMBER: number } = process.env;
    const deliveryFee = Number(process.env.DELIVERY_FEE_LKR || 0);
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) throw new Error("Invalid delivery fee");
    return { deliveryFee, bankAccount: bank && holder && number ? { bank, branch, holder, number } : null };
}

export function checkoutSettings(req, res) {
    const { deliveryFee, bankAccount } = paymentSettings();
    res.json({ deliveryFee, transferThreshold, transfersEnabled: Boolean(bankAccount) });
}

export async function createOrder(req, res) {
    if (!req.user?.email) return res.status(401).json({ message: "Sign in to place an order." });
    const { items, firstName, lastName, addressLine1, addressLine2, city, phone } = req.body;
    if (!Array.isArray(items) || !items.length || items.some(item =>
        !item || typeof item.productId !== "string" || !Number.isSafeInteger(item.qty) || item.qty < 1)) {
        return res.status(400).json({ message: "Invalid order items." });
    }
    const reject = (message) => { throw Object.assign(new Error(message), { status: 409 }); };
    try {
        const { deliveryFee, bankAccount } = paymentSettings();
        const order = await Order.db.transaction(async session => {
            const lines = [];
            let totalAmount = deliveryFee;
            for (const { productId, qty } of items) {
                const product = await Product.findOneAndUpdate(
                    { productId, isAvailable: true, stock: { $gte: qty } },
                    { $inc: { stock: -qty } }, { session }
                );
                if (!product) reject("A product is unavailable in the requested quantity.");
                const { name, images, price, labelledPrice } = product;
                lines.push({ product: { productId, name, image: images[0], price, labelledPrice }, qty });
                totalAmount += price * qty;
            }
            totalAmount = Math.round(totalAmount * 100) / 100;
            const paymentMethod = req.body.paymentMethod ?? (totalAmount >= transferThreshold ? "bank_transfer" : "cod");
            if (!["cod", "bank_transfer"].includes(paymentMethod)) reject("Choose a valid payment method.");
            if (paymentMethod === "cod" && totalAmount >= transferThreshold) reject("This order requires a bank transfer.");
            if (req.body.expectedTotal != null && req.body.expectedTotal !== totalAmount) {
                reject("Prices or delivery charges changed. Refresh your cart before ordering.");
            }
            if (paymentMethod === "bank_transfer" && !bankAccount) reject("Bank transfer is currently unavailable.");
            const counters = Order.db.collection("orderCounters");
            let sequence = await counters.findOneAndUpdate(
                { _id: "orders" }, { $inc: { value: 1 } }, { session, returnDocument: "after" }
            );
            if (!sequence) {
                const latest = await Order.findOne({ orderId: /^ORD[0-9]+$/ }, "orderId")
                    .collation({ locale: "en", numericOrdering: true }).sort({ orderId: -1 }).session(session);
                sequence = { _id: "orders", value: latest ? Number(latest.orderId.slice(3)) + 1 : 1 };
                await counters.insertOne(sequence, { session });
            }
            const orderId = "ORD" + String(sequence.value).padStart(6, "0");
            const [created] = await Order.create([{ orderId, email: req.user.email,
                firstName: firstName || req.user.firstName, lastName: lastName || req.user.lastName,
                addressLine1, addressLine2, city, phone, items: lines, totalAmount, deliveryFee, paymentMethod,
                paymentStatus: "awaiting_payment", bankAccount: paymentMethod === "bank_transfer" ? bankAccount : undefined
            }], { session });
            return created;
        });
        res.status(201).json({ message: "Order created successfully", orderId: order.orderId, order });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to place order." });
    }
}

export async function saveReceipt(req, res) {
    if (!req.user?.email) return res.sendStatus(401);
    const file = req.body;
    if (!Buffer.isBuffer(file)) return res.status(415).json({ message: "Choose a PDF, PNG or JPEG file." });
    let type;
    if (file.subarray(0, 5).toString() === "%PDF-") type = "application/pdf";
    else if (file.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") type = "image/png";
    else if (file.subarray(0, 3).toString("hex") === "ffd8ff") type = "image/jpeg";
    if (!type || !req.is(type)) return res.status(415).json({ message: "Invalid receipt format." });
    const order = await Order.findOneAndUpdate({
        orderId: req.params.orderId, email: req.user.email, paymentMethod: "bank_transfer",
        status: "pending", paymentStatus: { $in: ["awaiting_payment", "awaiting_verification"] }
    }, { receiptData: file, receiptType: type, paymentStatus: "awaiting_verification" }, { new: true });
    if (!order) return res.status(409).json({ message: "This order cannot accept a receipt." });
    res.json({ order });
}

export async function downloadReceipt(req, res) {
    if (!req.user?.email) return res.sendStatus(401);
    const filter = { orderId: req.params.orderId, receiptType: { $exists: true } };
    if (!req.user.isAdmin) filter.email = req.user.email;
    const order = await Order.findOne(filter).select("receiptType +receiptData");
    if (!order?.receiptData) return res.sendStatus(404);
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "attachment" }).type(order.receiptType).send(order.receiptData);
}

export async function updateBankPayment(req, res) {
    if (!req.user?.email) return res.status(401).json({ message: "Sign in first." });
    const filter = { orderId: req.params.orderId, paymentMethod: "bank_transfer", status: "pending",
        paymentStatus: { $in: ["awaiting_payment", "awaiting_verification"] } };
    let update;
    if (req.body.action === "confirm") {
        if (!req.user.isAdmin) return res.status(403).json({ message: "Admin access required." });
        update = { paymentStatus: "paid", status: "processing" };
    } else if (req.body.action === "submit_reference") {
        const reference = req.body.reference;
        if (typeof reference !== "string" || !reference.trim() || reference.length > 100)
            return res.status(400).json({ message: "Enter a transfer reference of up to 100 characters." });
        filter.email = req.user.email;
        update = { transferReference: reference.trim(), paymentStatus: "awaiting_verification" };
    } else return res.status(400).json({ message: "Invalid payment action." });
    try {
        const order = await Order.findOneAndUpdate(filter, update, { new: true });
        if (!order) return res.status(409).json({ message: "This order cannot accept that payment update. Refresh your orders." });
        res.json({ order });
    } catch {
        res.status(500).json({ message: "Could not update payment." });
    }
}

export async function getAllOrders(req, res) {

    // Check login
    if (req.user == null) {
        return res.status(401).json({
            message: "Unauthorized"
        });
    }

    if (!req.user.isAdmin) {
        return res.status(403).json({ message: "Only admins can access all orders" });
    }

    try {

        const pageSizeInString = req.params.pageSize || "10";
        const pageNumberString = req.params.pageNumber || "1";

        const pageSize = parseInt(pageSizeInString);
        const pageNumber = parseInt(pageNumberString);

        const filter = {};
        const { search = "", status = "" } = req.query;
        if (typeof search !== "string" || typeof status !== "string" || search.trim().length > 100) {
            return res.status(400).json({ message: "Invalid order filters" });
        }
        if (status) filter.status = status;
        if (search.trim()) {
            const escaped = search.trim().replace(/[.*+?^|{}()\[\]\\$]/g, "\\$&");
            const pattern = new RegExp(escaped, "i");
            filter.$or = [{ orderId: pattern }, { email: pattern }];
        }

        const orderCount = await Order.countDocuments(filter);
        const totalPages = Math.ceil(orderCount / pageSize);
        const orders = await Order.find(filter)
            .sort({ date: -1, _id: -1 })
            .skip((pageNumber - 1) * pageSize)
            .limit(pageSize);

        return res.json({
            orders: orders,
            totalPages: totalPages,
            currentPage: pageNumber,
            totalOrders: orderCount
        });

    } catch (err) {

        console.log(err);

        return res.status(500).json({
            message: err.message
        });
    }
}

export async function getOrdersByUser(req, res) {
    if (!req.user?.email) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const pageNumber = Number(req.params.pageNumber);
    const pageSize = Number(req.params.pageSize);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ message: "Invalid pagination" });
    }

    try {
        const filter = { email: req.user.email };
        const [orders, totalOrders] = await Promise.all([
            Order.find(filter).sort({ date: -1, _id: -1 })
                .skip((pageNumber - 1) * pageSize).limit(pageSize),
            Order.countDocuments(filter)
        ]);
        return res.json({
            orders,
            totalOrders,
            currentPage: pageNumber,
            totalPages: Math.ceil(totalOrders / pageSize)
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Unable to load orders" });
    }
}

export async function updateOrderStatus(req, res) {
    if (req.user == null || !req.user.isAdmin) {
        res.status(401).json({
            message: "Unauthorized"
        });
        return;
    }

    try {
        const status = req.body.status;
        if (!["pending", "processing", "shipped", "delivered", "completed", "cancelled", "returned"].includes(status))
            return res.status(400).json({ message: "Invalid order status." });
        const filter = { orderId: req.params.orderId };
        if (!["pending", "cancelled"].includes(status))
            filter.$or = [{ paymentMethod: { $ne: "bank_transfer" } }, { paymentStatus: "paid" }];
        const result = await Order.updateOne(filter, { status });
        if (!result.matchedCount) return res.status(409).json({ message: "Order unavailable or bank payment not confirmed." });

        res.status(200).json({
            message: "Order status updated successfully"
        });

    } catch (err) {
        res.status(500).json({
            message: err.message
        });
    }
}
