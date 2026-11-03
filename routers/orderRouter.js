import express from "express";
import { createOrder, getAllOrders, getOrdersByUser, updateOrderStatus } from "../controllers/orderController.js";

const orderRouter = express.Router();

orderRouter.post("/", createOrder);
orderRouter.get("/me/:pageNumber/:pageSize", getOrdersByUser);
orderRouter.get("/:pageNumber/:pageSize", getAllOrders)
orderRouter.put("/:orderId", updateOrderStatus)

export default orderRouter;