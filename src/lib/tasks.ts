import { readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";

const TASKS_FILE = process.env.TASKS_FILE ?? "/home/ofir/monitor/tasks.json";

export interface Task {
  id: string;
  text: string;
  projectId: string | null;
  done: boolean;
  createdAt: string;
}

export async function readTasks(): Promise<Task[]> {
  try {
    const raw = await readFile(TASKS_FILE, "utf-8");
    return JSON.parse(raw) as Task[];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: Task[]): Promise<void> {
  await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

export async function createTask(text: string, projectId: string | null = null): Promise<Task> {
  const tasks = await readTasks();
  const task: Task = {
    id: randomUUID(),
    text,
    projectId,
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  await writeTasks(tasks);
  return task;
}

export async function updateTask(id: string, patch: Partial<Pick<Task, "done" | "projectId">>): Promise<Task | null> {
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  await writeTasks(tasks);
  return tasks[idx];
}

export async function deleteTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  await writeTasks(tasks);
  return true;
}
