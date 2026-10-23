import type { Level } from '../game/content';

/** A schematic made from the actual scene and cohort definitions, never a decorative fake map. */
export function chapterMap(level: Level): string {
  const walls = level.scene.walls.map(w => `<rect x='${w.x}' y='${w.y}' width='${w.w}' height='${w.h}'/>`).join('');
  const people = level.groups.map(group => {
    const points: string[] = [];
    for (let row = 0; row < group.rows; row++) for (let col = 0; col < group.columns; col++) {
      points.push(`<circle cx='${group.origin.x + col * group.gap.x}' cy='${group.origin.y + row * group.gap.y}' r='.28' fill='${group.color}'/>`);
    }
    return points.join('');
  }).join('');
  return `<svg class='chapter-map' viewBox='-1 -1 30 20' aria-hidden='true'><g fill='#46524a'>${walls}</g>${people}</svg>`;
}
