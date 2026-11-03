import express from "express";
import { changePassword, createUser, listUsers, getUser, googleLogin, updateProfile } from "../controllers/userController.js";
import { loginUser } from "../controllers/userController.js";


const userRouter = express.Router();

userRouter.post("/create" , createUser);
userRouter.post("/login" , loginUser);
userRouter.get("/", listUsers);
userRouter.get("/me" , getUser);
userRouter.post("/change", changePassword);
userRouter.post("/update", updateProfile)
userRouter.post("/google-login", googleLogin);
export default userRouter;
