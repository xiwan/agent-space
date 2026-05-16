/**
 * TileMapper — maps logical tile types to tileset_all.png indices
 * and furniture items to sprite asset paths with size info.
 */

export const TILES = {
  floor_wood1: 0,
  floor_wood2: 1,
  rug: 2,
  floor_tile: 6,
  wall_plain: 16,
  wall_brick: 17,
  wall_lower: 18,
};

// Furniture: src + tile size. desktop:true = small item that goes ON a desk
export const FURNITURE = {
  desk:         { src: 'assets/desk/desk.png', tw: 2, th: 1 },
  monitor:      { src: 'assets/desk/monitor.png', tw: 1, th: 1 },
  keyboard:     { src: 'assets/desk/keyboard.png', tw: 1, th: 1, desktop: true },
  computer:     { src: 'assets/desk/monitor.png', tw: 1, th: 1 },
  mug:          { src: 'assets/desk/mug.png', tw: 1, th: 1, desktop: true },
  pen:          { src: 'assets/desk/pen.png', tw: 1, th: 1, desktop: true },
  penholder:    { src: 'assets/desk/penholder.png', tw: 1, th: 1, desktop: true },
  papers:       { src: 'assets/desk/papers.png', tw: 1, th: 1, desktop: true },
  phone:        { src: 'assets/desk/phone.png', tw: 1, th: 1, desktop: true },
  sticky_note:  { src: 'assets/desk/sticky_note.png', tw: 1, th: 1, desktop: true },
  whiteboard:   { src: 'assets/desk/whiteboard.png', tw: 1, th: 1 },
  extinguisher: { src: 'assets/desk/extinguisher.png', tw: 1, th: 1 },
  door:         { src: 'assets/desk/door.png', tw: 1, th: 1 },
  bookshelf:    { src: 'assets/room/bookshelf.png', tw: 1, th: 1 },
  plant:        { src: 'assets/room/plant1.png', tw: 1, th: 1 },
  sofa:         { src: 'assets/room/sofa.png', tw: 2, th: 1 },
  armchair:     { src: 'assets/room/armchair1.png', tw: 1, th: 1 },
  table:        { src: 'assets/room/table.png', tw: 1, th: 1 },
  lamp:         { src: 'assets/room/lamp.png', tw: 1, th: 1 },
  floor_lamp:   { src: 'assets/room/floor_lamp.png', tw: 1, th: 2 },
  tv:           { src: 'assets/room/tv.png', tw: 1, th: 1 },
  frame:        { src: 'assets/room/frame.png', tw: 1, th: 1 },
  shelf:        { src: 'assets/room/shelf.png', tw: 1, th: 1 },
  carpet:       { src: 'assets/room/carpet.png', tw: 3, th: 1 },
  cabinet:      { src: 'assets/room/bookshelf.png', tw: 1, th: 1 },
  server_rack:  { src: 'assets/room/bookshelf.png', tw: 1, th: 1 },
  chair:        { src: 'assets/room/armchair2.png', tw: 1, th: 1 },
};
