import Order from "../models/order.js";
import Product from "../models/product.js";

export async function createOrder(req, res) {
    try {

        // Check authentication
        if (req.user == null) {
            return res.status(401).json({
                message: "Unauthorized"
            });
        }

        const orderData = {
            orderId: "ORD000001",

            firstName: req.body.firstName || req.user.firstName,
            lastName: req.body.lastName || req.user.lastName,

            email: req.body.email || req.user.email,

            addressLine1: req.body.addressLine1,
            addressLine2: req.body.addressLine2,
            city: req.body.city,
            phone: req.body.phone,

            items: [],
            totalAmount: 0
        };

        // Find latest order
        const lastOrder = await Order.findOne().sort({
            date: -1
        });

        if (lastOrder != null) {

            const lastOrderId = lastOrder.orderId;

            const lastOrderNumberInString =
                lastOrderId.replace("ORD", "");

            const lastOrderNumber =
                parseInt(lastOrderNumberInString);

            const newOrderNumber =
                lastOrderNumber + 1;

            const newOrderNumberString =
                newOrderNumber.toString().padStart(6, "0");

            orderData.orderId =
                "ORD" + newOrderNumberString;
        }

        // Validate products
        for (let i = 0; i < req.body.items.length; i++) {

            const requestedItem = req.body.items[i];

            const foundProduct = await Product.findOne({
                productId: requestedItem.productId
            });

            if (foundProduct == null) {
                return res.status(400).json({
                    message:
                        "Product with id " +
                        requestedItem.productId +
                        " is not found"
                });
            }

            if (foundProduct.isAvailable == false) {
                return res.status(400).json({
                    message:
                        "Product with id " +
                        requestedItem.productId +
                        " is not available"
                });
            }

            if (requestedItem.qty > foundProduct.stock) {
                return res.status(400).json({
                    message:
                        "Product with id " +
                        requestedItem.productId +
                        " does not have enough stock"
                });
            }

            orderData.items.push({
                product: {
                    productId: foundProduct.productId,
                    name: foundProduct.name,
                    image: foundProduct.images[0],
                    price: foundProduct.price,
                    labelledPrice: foundProduct.labelledPrice
                },

                qty: requestedItem.qty
            });

            orderData.totalAmount +=
                foundProduct.price * requestedItem.qty;
        }

        // Save order
        const newOrder = new Order(orderData);

        await newOrder.save();

        // Reduce product stock
        for (let i = 0; i < req.body.items.length; i++) {

            await Product.updateOne(
                {
                    productId: req.body.items[i].productId
                },
                {
                    $inc: {
                        stock: -req.body.items[i].qty
                    }
                }
            );
        }

        return res.status(201).json({
            message: "Order created successfully",
            orderId: newOrder.orderId
        });

    } catch (err) {

        console.log(err);

        return res.status(500).json({
            message: err.message
        });
    }
}


// export async function getAllOrders(req, res) {
//     if(req.user == null ){
//         res.status(401).json({message: "Unauthorized"})
//         return
//     }

//     if (!req.user.isAdmin) {
//         return res.status(403).json({
//             message: "Only admins can access all orders"
//         });
//     }
//     try{
       
//             const pageSizeInString = req.params.pageSize || "10"
//             const pageNumberString = req.params.pageNumber || "1"
//             const pageSize = parseInt(pageSizeInString)
//             const pageNumber = parseInt(pageNumberString)

//             const orderCount = await Order.countDocuments()
//             const totalPages = Math.ceil(orderCount / pageSize)

//             const orders = await Order.find().sort({date : -1}).skip((pageNumber-1)*pageSize).limit(pageSize)

//             res.json({
//                 orders : orders,
//                 totalPages : totalPages,
//                 currentPage : pageNumber,
//                 totalOrders : orderCount
//             })
       
//     }catch(err){
//         res.json({message : err.message})
//     }
    
// }


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
        const order = await Order.findOne({
            orderId: req.params.orderId
        });

        if (!order) {
            res.status(404).json({
                message: "Order not found"
            });
            return;
        }

        await Order.updateOne(
            {
                orderId: req.params.orderId
            },
            {
                status: req.body.status
            }
        );

        res.status(200).json({
            message: "Order status updated successfully"
        });

    } catch (err) {
        res.status(500).json({
            message: err.message
        });
    }
}
