// Memory sampling for a process tree via /proc (Linux only). PSS is the fair
// number for multi-process shells: shared pages (e.g. Chromium's shared
// libraries across main/gpu/renderer) are divided between owners instead of
// being double-counted the way summed RSS would.

import { readdir, readFile } from "node:fs/promises";

async function listAllPids() {
  const entries = await readdir("/proc");
  return entries.filter((name) => /^\d+$/.test(name)).map(Number);
}

async function readPpid(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // Field 4 (ppid) comes after the parenthesized comm, which can itself
    // contain spaces and parens — split after the last ")".
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    return Number(afterComm.split(" ")[1]);
  } catch {
    return null;
  }
}

export async function listDescendants(rootPid) {
  const pids = await listAllPids();
  const children = new Map();
  for (const pid of pids) {
    const ppid = await readPpid(pid);
    if (ppid === null) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

async function readSmapsRollup(pid) {
  try {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const pss = rollup.match(/^Pss:\s+(\d+) kB$/m);
    const rss = rollup.match(/^Rss:\s+(\d+) kB$/m);
    return {
      pssKb: pss === null ? 0 : Number(pss[1]),
      rssKb: rss === null ? 0 : Number(rss[1]),
    };
  } catch {
    // Process exited between listing and reading, or permission denied.
    return null;
  }
}

async function readComm(pid) {
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return "?";
  }
}

/**
 * Sum PSS/RSS over a root process and all its descendants. Caveat: children
 * that reparent away (double-fork daemons, some sandbox brokers) are missed;
 * the per-process breakdown in the result makes gaps visible.
 */
export async function sampleProcessTreeMemory(rootPid) {
  if (process.platform !== "linux") {
    // No /proc off-Linux; report an empty sample instead of failing the run.
    return { processCount: 0, processes: [], totalPssKb: 0, totalRssKb: 0 };
  }
  const pids = await listDescendants(rootPid);
  const processes = [];
  let totalPssKb = 0;
  let totalRssKb = 0;
  for (const pid of pids) {
    const memory = await readSmapsRollup(pid);
    if (memory === null) continue;
    processes.push({ comm: await readComm(pid), pid, ...memory });
    totalPssKb += memory.pssKb;
    totalRssKb += memory.rssKb;
  }
  return { processCount: processes.length, processes, totalPssKb, totalRssKb };
}
