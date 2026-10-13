import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  CreateTaskBody,
  CreateTaskResponse,
  ListTasksQueryParams,
  ListTasksResponse,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateTaskResponse,
} from "@workspace/api-zod";
import { db, tasksTable } from "@workspace/db";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toTask(row: typeof tasksTable.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assignedTo: row.assignedTo,
    dueDate: row.dueDate ? new Date(`${row.dueDate}T00:00:00`) : null,
    priority: row.priority,
    status: row.status,
    createdAt: row.createdAt,
    source: row.source,
  };
}

router.get("/tasks", async (req, res, next) => {
  try {
    const query = ListTasksQueryParams.parse(req.query);
    const rows = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt));
    const items = query.status && query.status !== "all" ? rows.filter((row) => row.status === query.status) : rows;
    res.json(ListTasksResponse.parse(items.map(toTask)));
  } catch (error) {
    next(error);
  }
});

router.post("/tasks", async (req, res, next) => {
  try {
    const body = CreateTaskBody.parse(req.body);
    const [row] = await db
      .insert(tasksTable)
      .values({
        title: body.title,
        description: body.description,
        assignedTo: body.assignedTo,
        dueDate: body.dueDate ? body.dueDate.toISOString().slice(0, 10) : null,
        priority: body.priority,
        status: "open",
        source: "manual",
        createdBy: "local",
      })
      .returning();
    void recordAudit({ action: "task.created", entityType: "task", entityId: row.id, details: row.title });
    res.status(201).json(CreateTaskResponse.parse(toTask(row)));
  } catch (error) {
    next(error);
  }
});

router.patch("/tasks/:id", async (req, res, next) => {
  try {
    const { id } = UpdateTaskParams.parse(req.params);
    const body = UpdateTaskBody.parse(req.body);
    const [row] = await db
      .update(tasksTable)
      .set({
        status: body.status,
        assignedTo: body.assignedTo,
        description: body.description,
        dueDate: body.dueDate === undefined ? undefined : body.dueDate ? body.dueDate.toISOString().slice(0, 10) : null,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Vazifa topilmadi" });
      return;
    }
    void recordAudit({ action: "task.updated", entityType: "task", entityId: row.id, details: row.title });
    res.json(UpdateTaskResponse.parse(toTask(row)));
  } catch (error) {
    next(error);
  }
});

export default router;
