// Memory sampling for a process tree via /proc (Linux only). PSS divides
// shared pages between owners, which is the fair total for a multi-process
// shell; summed RSS double-counts them. A copy of this helper also exists in
// experimental/desktop-wrapper-spikes/shared/ — the spikes stay dependency-free
// of the product tree on purpose.

import { readdir, readFile } from "node:fs/promises";

async function listAllPids() {
  const entries = await readdir("/proc");
  return entries.filter((name) => /^\d+$/.test(name)).map(Number);
}

async function readPpid(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
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
