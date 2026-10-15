import { normalizeText } from '../core/utils.js';

function clean(value) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}@_\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a command only when its keyword is at the start of the comment. */
export function parse(text, config) {
  const normalized = clean(text);
  if (!normalized) return null;
  const commands = config?.commands ?? config ?? {};
  const definitions = [
    { cmd: 'join', aliases: commands.join, hasArg: false },
    { cmd: 'attack', aliases: commands.attack, hasArg: false },
    { cmd: 'dodge', aliases: commands.dodge, hasArg: false },
    { cmd: 'ally', aliases: commands.ally, hasArg: true },
    { cmd: 'betray', aliases: commands.betray, hasArg: false },
    { cmd: 'giftTarget', aliases: [...(commands.rescue ?? []), ...(commands.giftTarget ?? [])], hasArg: true },
  ];
  const aliases = definitions.flatMap((definition) => (definition.aliases ?? []).map((alias) => ({
    cmd: definition.cmd,
    hasArg: definition.hasArg,
    keyword: clean(alias),
  }))).filter((item) => item.keyword).sort((a, b) => b.keyword.length - a.keyword.length);

  for (const { cmd, hasArg, keyword } of aliases) {
    if (normalized === keyword) return hasArg ? null : { cmd, arg: '' };
    if (!normalized.startsWith(`${keyword} `)) continue;
    if (!hasArg) return null;
    const arg = normalized.slice(keyword.length).trim().replace(/^@+/, '').trim();
    return arg ? { cmd, arg } : null;
  }
  return null;
}

export const parseCommand = parse;
