export function getClass(config, classId) {
  return config.classes[classId] ?? config.classes[config.classOrder[0]];
}

const assignments = new WeakMap();

export function pickClassId(config, rng = Math.random, players) {
  const order = config.classOrder.filter((id) => config.classes[id]);
  if (!order.length) throw new Error('No configured player classes');
  let counts;
  if (players) {
    counts = new Map(order.map((id) => [id, 0]));
    for (const player of players) {
      if (player.status !== 'spectator' && counts.has(player.classId)) {
        counts.set(player.classId, counts.get(player.classId) + 1);
      }
    }
  } else {
    if (!assignments.has(config)) assignments.set(config, new Map());
    counts = assignments.get(config);
  }
  const minimum = Math.min(...order.map((id) => counts.get(id) ?? 0));
  const candidates = order.filter((id) => (counts.get(id) ?? 0) === minimum);
  const chosen = candidates[Math.floor(rng() * candidates.length)] ?? candidates[0];
  if (!players) counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
  return chosen;
}
