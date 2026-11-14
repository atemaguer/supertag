const colors = ["peach", "mint", "lilac", "blue", "yellow"];

export function TagAvatar({ tagId, large }: { tagId: string; large?: boolean }) {
  let hash = 0;
  for (const letter of tagId) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${colors[hash % colors.length]}${large ? " large" : ""}`} aria-hidden>
      <span className={`mark mark-${hash % 3}`} />
    </span>
  );
}
