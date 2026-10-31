import { describe, expect, it } from 'vitest';
import { parseDiff, toSplit } from './diff';

const raw = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 un
-deux
+DEUX
 trois
`;

describe('parseDiff', () => {
  it('numérote les lignes et compte les changements', () => {
    const d = parseDiff(raw);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['ctx', 3, 3],
    ]);
  });

  it('aligne suppressions et ajouts en vue côte à côte', () => {
    const split = toSplit(parseDiff(raw).hunks[0].lines);
    expect(split.length).toBe(3);
    expect(split[1][0]?.text).toBe('deux');
    expect(split[1][1]?.text).toBe('DEUX');
  });
});
