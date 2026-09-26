import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withPackageWriteLock<T>(indexPath: string, work: () => Promise<T>): Promise<T> {
  const path = `${indexPath}.mutex`;
  const nonce = randomUUID();
  const deadline = Date.now() + 10000;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; nonce?: string } | undefined;
      try { owner = JSON.parse(await readFile(path, "utf8")) as typeof owner; }
      catch { /* an owner may still be writing its new lock */ }
      let live = true;
      if (Number.isSafeInteger(owner?.pid) && owner!.pid! > 0) {
        try { process.kill(owner!.pid!, 0); }
        catch (check) { if ((check as NodeJS.ErrnoException).code === "ESRCH") live = false; }
      }
      let age = 0;
      try { age = Date.now() - (await stat(path)).mtimeMs; }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue; throw missing; }
      if ((!live && age > 500) || (!owner && age > 30000)) {
        try { await unlink(path); continue; }
        catch (removed) { if ((removed as NodeJS.ErrnoException).code !== "ENOENT") throw removed; }
      }
      if (Date.now() >= deadline) throw new Error(`package index is busy: ${indexPath}`);
      await pause(30);
    }
  }
  try { return await work(); }
  finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as { nonce?: string };
      if (current.nonce === nonce) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
