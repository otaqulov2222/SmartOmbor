import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dataRouter from "./data";
import partnersRouter from "./partners";

const router: IRouter = Router();

router.use(healthRouter);
router.use(partnersRouter);
router.use(dataRouter);

export default router;
