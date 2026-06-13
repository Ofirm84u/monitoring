import { readFile, writeFile, rename } from "fs/promises";

const NOTES_FILE = process.env.NOTES_FILE ?? "/home/ofir/monitor/project-notes.json";

export type ProjectStage = "production" | "qa" | "dev" | "paused";

export interface ProjectNote {
  stage: ProjectStage;
  brief: string;
  nextSteps: string[];
}

export type NotesMap = Record<string, ProjectNote>;

export async function readNotes(): Promise<NotesMap> {
  try {
    const raw = await readFile(NOTES_FILE, "utf-8");
    return JSON.parse(raw) as NotesMap;
  } catch {
    return {};
  }
}

export async function writeNote(id: string, note: ProjectNote): Promise<NotesMap> {
  const notes = await readNotes();
  notes[id] = note;
  const tmp = `${NOTES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(notes, null, 2), "utf-8");
  await rename(tmp, NOTES_FILE);
  return notes;
}
