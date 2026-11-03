import express from "express";
import { saveReceipt, downloadReceipt, checkoutSettings, updateBankPayment, createOrder, getAllOrders, getOrdersByUser, updateOrderStatus } from "../controllers/orderController.js";

const orderRouter = express.Router();

orderRouter.get("/checkout-settings", checkoutSettings);
orderRouter.get("/:orderId/receipt", downloadReceipt);
orderRouter.put("/:orderId/receipt", express.raw({ type: ["image/png", "image/jpeg", "application/pdf"], limit: "5mb" }), saveReceipt);
orderRouter.patch("/:orderId/payment", updateBankPayment);
orderRouter.post("/", createOrder);
orderRouter.get("/me/:pageNumber/:pageSize", getOrdersByUser);
orderRouter.get("/:pageNumber/:pageSize", getAllOrders)
orderRouter.put("/:orderId", updateOrderStatus)

export default orderRouter;