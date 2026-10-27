/**
 * @param {Awaited<ReturnType<import("@getpaseo/client").PaseoAgentHandle["timeline"]["refetch"]>>} page
 * @param {import("@getpaseo/client").PaseoAgent} snapshot
 * @param {string | null} [turnId]
 */
export function findQuotaNotice(page, snapshot, turnId) {
  if (
    snapshot.provider !== "claude" ||
    snapshot.activeTurn ||
    snapshot.pendingPermissions.length ||
    !["idle", "error"].includes(snapshot.status) ||
    snapshot.lastUsage?.outputTokens !== 0 ||
    page.error ||
    page.hasNewer ||
    page.staleCursor ||
    page.gap
  )
    return null;
  const lastUserMessageAt = snapshot.lastUserMessageAt;
  if (
    typeof lastUserMessageAt !== "string" ||
    !Number.isFinite(Date.parse(lastUserMessageAt))
  )
    return null;
  const entry = page.entries.findLast(
    ({ item }) =>
      item.type === "user_message" || item.type === "assistant_message",
  );
  if (
    !entry ||
    entry.provider !== "claude" ||
    entry.item.type !== "assistant_message" ||
    !entry.item.messageId ||
    !entry.turnId ||
    (turnId && entry.turnId !== turnId) ||
    !Number.isFinite(Date.parse(entry.timestamp)) ||
    Date.parse(entry.timestamp) < Date.parse(lastUserMessageAt)
  )
    return null;
  // Match native boilerplate from a zero-output turn, never a keyword inside prose or a quote.
  if (
    !/^You(?:'ve|’ve| have) hit your (?:session|weekly|usage) limit[ \t]*[·•][ \t]*resets [^\r\n]{1,100}$/i.test(
      entry.item.text.trim(),
    )
  )
    return null;
  return { id: entry.item.messageId, lastUserMessageAt };
}
