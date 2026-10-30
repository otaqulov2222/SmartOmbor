import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dataRouter from "./data";
import partnersRouter from "./partners";
import tasksRouter from "./tasks";
import auditRouter from "./audit";
import settingsRouter from "./settings";
import localAuthRouter from "./local-auth";
import officeRouter from "./office";

const router: IRouter = Router();

router.use(healthRouter);
router.use(localAuthRouter);
router.use(officeRouter);
router.use(partnersRouter);
router.use(tasksRouter);
router.use(auditRouter);
router.use(settingsRouter);
router.use(dataRouter);

export default router;
