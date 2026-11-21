import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, upload } from "../api.js";
import { ANY_MIME, clientKinds, kindForMime, type KindMeta } from "./attachment-kinds.js";

export interface Chip {
  key: string;
  type: "upload" | "file";
  kindId: string;
  name: string;
  size?: number;
  status: "uploading" | "ready" | "error";
  serverId?: string;
  error?: string;
  thumbnail?: string;
  path?: string;
  /** Where the browser said an uploaded file came from; sent with every upload of it. */
  source?: string;
  /** Kept in memory so a failed or expired upload can be retried. */
  file?: File;
}

interface Staged {
  id: string;
}

// Ready chips survive a session switch while the page lives; a reload drops them (the server expires staged uploads).
const kept = new Map<string, Chip[]>();

let counter = 0;
const nextKey = () => `chip-${++counter}`;

export function useAttachments(sessionId: string, metas: KindMeta[]) {
  const [chips, setChips] = useState<Chip[]>(
    () => kept.get(sessionId)?.filter((chip) => chip.status === "ready") ?? [],
  );
  const controllers = useRef(new Map<string, AbortController>());
  const latest = useRef(chips);
  latest.current = chips;
  const metasRef = useRef(metas);
  metasRef.current = metas;

  useEffect(() => {
    kept.set(sessionId, chips.filter((chip) => chip.status === "ready"));
  }, [sessionId, chips]);
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    [],
  );

  const patch = useCallback((key: string, change: Partial<Chip>) => {
    setChips((old) =>
      old.map((chip) => (chip.key === key ? { ...chip, ...change } : chip)),
    );
  }, []);

  const start = useCallback(
    (key: string, file: File, source?: string) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      upload<Staged>(sessionId, file, controller.signal, source)
        .then((staged) => patch(key, { status: "ready", serverId: staged.id }))
        .catch((cause) => {
          if (!controller.signal.aborted)
            patch(key, { status: "error", error: errorText(cause) });
        })
        .finally(() => controllers.current.delete(key));
    },
    [sessionId, patch],
  );

  const addFiles = useCallback(
    (files: File[], sources: readonly (string | undefined)[] = []) => {
      for (const [index, file] of files.entries()) {
        const source = sources[index];
        const key = nextKey();
        const known = metasRef.current;
        const meta = known.length ? kindForMime(known, file.type) : undefined;
        const base: Chip = {
          key,
          type: "upload",
          kindId: meta?.id ?? "image",
          name: file.name || (file.type.startsWith("image/") ? "pasted-image" : "pasted-file"),
          size: file.size,
          status: "uploading",
          file,
          ...(source ? { source } : {}),
        };
        if (known.length && !meta) {
          const accepted = known.flatMap((entry) => entry.accept).join(", ");
          setChips((old) => [
            ...old,
            { ...base, status: "error", error: `Unsupported type. Accepted: ${accepted}` },
          ]);
          continue;
        }
        if (meta && file.size > meta.maxBytes) {
          setChips((old) => [
            ...old,
            {
              ...base,
              status: "error",
              error: `Too large (limit ${Math.round(meta.maxBytes / 1048576)} MiB)${meta.accept.includes(ANY_MIME)
                ? ". Put it in the workspace and reference it with @, or drop it from your editor to send its path" : ""}`,
            },
          ]);
          continue;
        }
        setChips((old) => [...old, base]);
        start(key, file, source);
        void clientKinds
          .get(base.kindId)
          ?.thumbnail?.(file)
          .then((thumbnail) => thumbnail && patch(key, { thumbnail }))
          .catch(() => {});
      }
    },
    [start, patch],
  );

  const addFileRef = useCallback((path: string) => {
    setChips((old) =>
      old.some((chip) => chip.type === "file" && chip.path === path)
        ? old
        : [
            ...old,
            {
              key: nextKey(),
              type: "file",
              kindId: "file",
              name: path.split("/").at(-1) ?? path,
              path,
              status: "ready",
            },
          ],
    );
  }, []);

  const remove = useCallback(
    (key: string) => {
      const chip = latest.current.find((entry) => entry.key === key);
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      if (chip?.type === "upload" && chip.status === "ready" && chip.serverId)
        void api(
          `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(chip.serverId)}`,
          "DELETE",
        ).catch(() => {});
      setChips((old) => old.filter((entry) => entry.key !== key));
    },
    [sessionId],
  );

  const retry = useCallback(
    (key: string) => {
      const chip = latest.current.find((entry) => entry.key === key);
      if (!chip?.file) return;
      patch(key, { status: "uploading" });
      setChips((old) =>
        old.map((entry) => {
          if (entry.key !== key) return entry;
          const { error: _error, serverId: _id, ...rest } = entry;
          return rest;
        }),
      );
      start(key, chip.file, chip.source);
    },
    [patch, start],
  );

  /** Marks ready uploads whose staged item the server no longer knows, so they can be retried. */
  const expire = useCallback(() => {
    setChips((old) =>
      old.map((chip) => {
        if (chip.type !== "upload" || chip.status !== "ready") return chip;
        const { serverId: _id, ...rest } = chip;
        return { ...rest, status: "error", error: "Expired; retry to attach it again" };
      }),
    );
  }, []);

  /** Drops chips after their operation was accepted (the server consumed the staged items). */
  const consume = useCallback((keys: string[]) => {
    setChips((old) => old.filter((chip) => !keys.includes(chip.key)));
  }, []);

  /**
   * Adds items the server staged for this chat (an edited message's images) as ready chips. `file` is their copy in
   * this page: a request consumes its staged items, so Retry uploads that copy again.
   */
  const addStaged = useCallback(
    (items: Array<{ id: string; kind: string; name: string; byteSize: number; source?: string | undefined; file?: File | undefined }>) => {
      const added = items.map((item): Chip => ({ key: nextKey(), type: "upload", kindId: item.kind, name: item.name, size: item.byteSize,
        status: "ready", serverId: item.id, ...(item.source ? { source: item.source } : {}), ...(item.file ? { file: item.file } : {}) }));
      setChips((old) => [...old, ...added]);
      for (const chip of added)
        if (chip.file)
          void clientKinds
            .get(chip.kindId)
            ?.thumbnail?.(chip.file)
            .then((thumbnail) => thumbnail && patch(chip.key, { thumbnail }))
            .catch(() => {});
    },
    [patch],
  );

  /** Puts back chips taken by a request the server refused; their staged items are still there. */
  const restore = useCallback((back: Chip[]) => {
    setChips((old) => [...old, ...back.filter((chip) => !old.some((entry) => entry.key === chip.key))]);
  }, []);

  const summary = useMemo(
    () => ({
      uploading: chips.some((chip) => chip.status === "uploading"),
      failed: chips.some((chip) => chip.status === "error"),
      images: chips.filter((chip) => chip.type === "upload" && chip.status === "ready"),
      files: chips.filter((chip) => chip.type === "file"),
    }),
    [chips],
  );
  return { chips, ...summary, addFiles, addFileRef, addStaged, remove, retry, expire, consume, restore };
}
