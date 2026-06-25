/* =========================================================================
   PixelQuest — an isometric browser MMO prototype.

   A single-player, no-backend build: the "other players" are local bots, and
   wallet connect is used purely as a login identity that picks which save slot
   to load.

   Mechanics:
     - Click-to-move on an isometric tile map.
     - Per-skill XP that levels up: Woodcutting, Mining, Fishing (cap 20).
     - Tools gate gathering: Axe -> trees, Pickaxe -> stone & coal, Rod -> fish.
     - A Forge upgrades tools; higher tiers gather more and grant more XP.

   No tokens, no transactions, no on-chain calls. Identity only.
   ========================================================================= */

// ---- Isometric world config -------------------------------------------------
const TILE_W = 64;
const TILE_H = 32;
const GRID = 44;
const MOVE_SPEED = 4.6;          // tiles per second
const SKILL_CAP = 20;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.2;

// grid <-> screen
function isoX(gx, gy) { return (gx - gy) * (TILE_W / 2); }
function isoY(gx, gy) { return (gx + gy) * (TILE_H / 2); }
function isoDepth(gx, gy) { return gx + gy; }

// ---- directional (8-way) animated characters -------------------------------
// AxulArt "Small 8-direction Characters" (CC-BY 4.0). Sheet is 16x24 frames,
// 8 columns = directions [N,NE,E,SE,S,SW,W,NW], rows grouped per character
// (arrow legend row, then 3 walk frames). Boy=rows 5-7, Girl=rows 9-11.
const AXUL_COLS = 8, AXUL_DIR_S = 4;       // column 4 faces the camera (south)
// first (idle) frame row per outfit. boy/girl ship in the pack; the rest are
// palette-swapped villager variants baked into the sheet for crowd variety.
const AXUL_ROW = { boy: 5, girl: 9, red: 12, green: 15, purple: 18, pink: 21, gold: 24 };
const TOWNSFOLK = ['girl', 'green', 'purple', 'pink', 'gold', 'boy'];   // bot outfits
const FIGHTERS = ['red', 'boy', 'purple', 'green'];                     // arena outfits
// Map a screen-movement octant -> direction column. Octant 0 = moving screen-east,
// then clockwise (SE, S, SW, W, NW, N, NE). Tune if facings ever look wrong.
const AXUL_DIR_COLS = [2, 3, 4, 5, 6, 7, 0, 1];

// ---- Tools & skills ---------------------------------------------------------
const TOOLS = {
  axe:     { id: 'axe',     name: 'Axe',         skill: 'woodcutting' },
  pickaxe: { id: 'pickaxe', name: 'Pickaxe',     skill: 'mining'      },
  rod:     { id: 'rod',     name: 'Fishing Rod', skill: 'fishing'     },
  sword:   { id: 'sword',   name: 'Sword',       skill: 'combat'      },
};
const TOOL_ORDER = ['axe', 'pickaxe', 'rod', 'sword'];

// resource node definitions
const NODES = {
  tree: { item: 'wood',  tool: 'axe',     skill: 'woodcutting', base: 1.4, xp: 8,  max: 5, respawn: 120000, tex: 'tree'  },
  rock: { item: 'stone', tool: 'pickaxe', skill: 'mining',      base: 1.8, xp: 10, max: 5, respawn: 150000, tex: 'rock'  },
  coal: { item: 'coal',  tool: 'pickaxe', skill: 'mining',      base: 2.3, xp: 17, max: 4, respawn: 180000, tex: 'coal'  },
};

// fishing isn't a node — you cast onto any water tile. base = seconds until a bite.
const FISH = { item: 'fish', skill: 'fishing', xp: 9, base: 15.0 };

// tier tuning: speed multiplier (lower=faster), yield per gather, xp multiplier
const TIER = {
  1: { speed: 1.00, yield: 1, xpMult: 1 },
  2: { speed: 0.70, yield: 2, xpMult: 2 },
  3: { speed: 0.50, yield: 3, xpMult: 3 },
};
const MAX_TIER = 3;

// forge upgrade costs: tier you are upgrading TO -> {item, amount}
const UPGRADE_COST = {
  axe:     { 2: { wood: 15 },  3: { wood: 40 } },
  pickaxe: { 2: { stone: 15 }, 3: { stone: 30, coal: 12 } },
  rod:     { 2: { fish: 12 },  3: { fish: 35 } },
};

function xpToNext(level) { return Math.floor(50 * Math.pow(1.2, level - 1)); }

// ---- biomes, structures & realms -------------------------------------------
const BIOMES = {
  grass: { a: 'gA', b: 'gB', water: 'water', sand: 'sand', mmLand: 0x2f5a32, mmWater: 0x2f74b8 },
  wild:  { a: 'wA', b: 'wB', water: 'wwater', sand: 'wsand', mmLand: 0x3a352b, mmWater: 0x39434d },
  interior: { a: 'bankfloor_a', b: 'bankfloor_b', water: 'water', sand: 'sand', mmLand: 0x4a3c28, mmWater: 0x2f74b8 },
};
const STRUCT_TEX = { forge: 'forge', house: 'house', fountain: 'fountain', bonfire: 'roastpit', tombstone: 'tombstone' };
// colourful iso houses for the village; dark medieval ones (house1-3) are wilderness-only
const HOUSE_TEX = ['cs_house', 'cs_villa', 'cs_tavern', 'cs_inn', 'cs_thatched'];

// ---- crisp SVG icons (no emoji) — used both in the DOM and as Phaser textures ----
const ICON_SVG = {
  bank:     '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9 12 3l9 6"/><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9"/><path d="M3 20h18"/></svg>',
  merchant: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l1.2 12H4.8z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
  casino:   '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4" fill="#fff"/><circle cx="15" cy="9" r="1.4" fill="#fff"/><circle cx="12" cy="12" r="1.4" fill="#fff"/><circle cx="9" cy="15" r="1.4" fill="#fff"/><circle cx="15" cy="15" r="1.4" fill="#fff"/></svg>',
  cooking:  '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M3 12c4-5 11-5 14 0-3 5-10 5-14 0z"/><path d="M17 12l4-3v6z"/><circle cx="8" cy="11" r="1" fill="#fff"/></svg>',
  coin:     '<svg viewBox="0 0 24 24" fill="none" stroke="#ffd76b" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/></svg>',
  fish:     '<svg viewBox="0 0 24 24" fill="none" stroke="#9fd8ff" stroke-width="2" stroke-linejoin="round"><path d="M3 12c4-5 11-5 14 0-3 5-10 5-14 0z"/><path d="M17 12l4-3v6z"/><circle cx="8" cy="11" r="1" fill="#9fd8ff"/></svg>',
  map:      '<svg viewBox="0 0 24 24" fill="none" stroke="#dfe6ff" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
  forge:    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M4 9h11l-2 4H7z"/><path d="M10.5 13v4M7 20h7"/><path d="M15 9l4-1.5V11"/></svg>',
  arena:    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M4 4l9 9M20 4l-9 9"/><path d="M11 13l-3 3M13 13l3 3"/></svg>',
  inventory:'<svg viewBox="0 0 24 24" fill="none" stroke="#dfe6ff" stroke-width="2" stroke-linejoin="round"><path d="M4 8h16v12H4z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/><path d="M4 13h16"/></svg>',
  skills:   '<svg viewBox="0 0 24 24" fill="none" stroke="#dfe6ff" stroke-width="2" stroke-linecap="round"><path d="M4 20h16"/><path d="M7 20v-6M12 20V8M17 20v-9"/></svg>',
  trophy:   '<svg viewBox="0 0 24 24" fill="none" stroke="#ffd76b" stroke-width="2" stroke-linejoin="round"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/><path d="M10 15v3M14 15v3M8 20h8"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="#cfd6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
};
const svgDataURI = svg => 'data:image/svg+xml;base64,' + btoa(svg);
// footprint size (in tiles) + sprite anchor — multi-tile structures cover a block
const STRUCT_INFO = {
  house:    { fw: 2, fh: 2, anchorY: 0.9, lift: 0 },
  forge:    { fw: 2, fh: 2, anchorY: 0.86, lift: 10 },
  bonfire:  { fw: 2, fh: 2, anchorY: 0.84, lift: 8 },
  fountain: { fw: 3, fh: 3, anchorY: 0.82, lift: 10 },
  tombstone:{ fw: 1, fh: 1, anchorY: 0.85, lift: 4 },
};
const pool = (cx, cy, r) => (gx, gy) => Math.hypot(gx - cx, gy - cy) < r;   // circular water region

const REALMS = {
  mainland: {
    name: 'Mainland', biome: 'grass', water: pool(6, 37, 5), spawn: { x: 20, y: 24 },
    arena: { cx: 3, cy: 3, r: 3 },                       // PvP ring, top corner
    plaza: { cx: 21, cy: 20, r: 4 },                     // central healing plaza around the fountain
    treeArea: { cx: 34, cy: 7, r: 8 },                   // dense woodcutting forest, top-right
    rockArea: { cx: 33, cy: 35, r: 6 },                  // rocky ground around the Miner's Cave, bottom-right
    resources: { tree: 120, rock: 16, coal: 9 }, shadows: 3,
    bots: { count: 17, anglers: 3, visitors: 2, choppers: 5, miners: 3 },
    enemies: { fighter: 1 },
    dummies: [[6, 10], [9, 10], [6, 12], [9, 12]],       // attackable practice dummies at the Training Ground

    structures: [
      { type: 'fountain', x: 20, y: 19 },                // central healing plaza
      { type: 'house', x: 16, y: 31 }, { type: 'house', x: 20, y: 31 }, { type: 'house', x: 24, y: 31 },
      { type: 'house', x: 17, y: 36 }, { type: 'house', x: 21, y: 36 },        // village cluster, south
      { type: 'sign', x: 1, y: 7, text: 'PvP ARENA', color: '#ffd76b' },
      { type: 'sign', x: 38, y: 24, to: 'wilderness', danger: true, text: 'DANGER ZONE', color: '#ff6a6a', span: 6 }, // right edge (strip gx 38–43), where you pointed
    ],
    // bare/dead trees framing the danger-zone entrance (above & below the gate strip, not on it)
    deadTrees: [[37, 22], [40, 22], [43, 22], [36, 26], [39, 27], [42, 27]],
    // interactive buildings: walk up + press E. Cooking fire sits by the pond.
    buildings: [
      { key: 'bank',     name: 'Bank',         gx: 19, gy: 6,  tex: 'cs_villa',  icon: 'bank',     color: '#ffd76b', w: 210, entry: [{ gx: 19, gy: 8 }, { gx: 20, gy: 8 }], entryTo: 'bankin' },
      { key: 'merchant', name: 'Merchant',     gx: 15, gy: 16, tex: 'cs_inn',    icon: 'merchant', color: '#9fffcb' },
      { key: 'casino',   name: 'Casino',       gx: 29, gy: 28, tex: 'cs_tavern', icon: 'casino',   color: '#ff9ad2', entry: [{ gx: 29, gy: 26 }, { gx: 30, gy: 26 }], entryTo: 'casinoin' },
      { key: 'bonfire',  name: 'Cooking Fire', gx: 4,  gy: 26, tex: 'campfire', anim: 'campfire', scale: 1.9, icon: 'cooking', color: '#ffb86b', small: true },
      // tool station: lumberjack NPC by the forest hands you the Axe
      { key: 'woodcamp', name: "Woodcutter's Camp", npcName: 'Old Lumberjack', gx: 29, gy: 13, npc: 'green', gives: 'axe', color: '#9fffcb',
        line: "Well met, traveler! Looking to make a living off the land? Take this axe — go fell a few trees and you'll be a woodcutter in no time.",
        decor: [[-1, -1, 'stump', 1.3], [2, 0, 'logstack', 1.05], [-2, 1, 'logstack', 0.9],
          [2, -1, 'log1', 1.3], [-1, 2, 'log1', 1.2], [1, 2, 'log1', 1.1],
          [-2, -1, 'log1', 1.0], [2, 2, 'log1', 1.15], [0, 2, 'stump', 0.85]] },
      // tool station: angler NPC at the pond's edge hands you the Fishing Rod
      { key: 'fishcamp', name: "Fisher's Hut", npcName: 'Old Angler', gx: 10, gy: 33, npc: 'boy', gives: 'rod', color: '#9fd8ff',
        line: "Ahoy there! This pond's brimming with fish just waiting to bite. Take this rod — cast it on the water and reel one in. You'll be an angler before sundown.",
        decor: [[1, -1, 'barrel', 1.2], [-1, -1, 'fishbasket', 1.05], [2, 0, 'fishcrate', 1.1],
          [0, -2, 'barrel', 0.95], [2, -2, 'fishbasket', 0.85], [-2, -1, 'fishcrate', 0.9]] },
      // tool station: miner NPC by the cave mouth hands you the Pickaxe
      { key: 'minecamp', name: "Miner's Cave", npcName: 'Grizzled Miner', gx: 33, gy: 35, npc: 'gold', gives: 'pickaxe', color: '#ffcf8f',
        line: "Hah! Fresh blood for the mines, are ye? Take this pickaxe — go crack open the rocks 'round the cave and haul up some stone. You'll have muscles like mine in no time.",
        decor: [[-1, -2, 'cavemouth', 1.15], [1, -1, 'boulder', 1.1], [2, 0, 'minecart', 1.0],
          [-2, 0, 'boulder', 0.85], [1, 1, 'boulder', 0.8], [-1, 2, 'boulder', 0.75]] },
      // tool station: combat instructor by the arena hands you the Sword
      { key: 'traincamp', name: 'Training Ground', npcName: 'Combat Instructor', gx: 7, gy: 14, npc: 'red', gives: 'sword', color: '#ff9a9a',
        line: "So you fancy a fight, do ye? Take this blade. Warm up on the dummies here — then prove yourself: head into the Wilderness and slay a creeper.",
        decor: [[-2, -2, 'weaponrack', 1.0], [3, -2, 'weaponrack', 0.95], [0, -6, 'target', 0.9], [4, -4, 'target', 0.85]] },
    ],
  },
  // walkable bank interior — entered by stepping the bank's doorstep arrows
  bankin: {
    name: 'Bank', biome: 'interior', interior: true, water: () => false,
    spawn: { x: 21, y: 22 },
    room: { x0: 17, y0: 16, x1: 26, y1: 23 },        // inclusive floor rectangle
    exit: { gx: 21, gy: 23, to: 'mainland', spawn: { x: 20, y: 9 } },
    vault: true,
    buildings: [
      { key: 'bank', name: 'Banker', npcName: 'Banker', gx: 21, gy: 18, npc: 'gold', icon: 'bank', color: '#ffd76b' },
    ],
  },
  // walkable casino interior — two roulette + two blackjack tables, black-suited dealers
  casinoin: {
    name: 'Casino', biome: 'interior', interior: true, water: () => false,
    spawn: { x: 21, y: 23 },
    room: { x0: 16, y0: 15, x1: 27, y1: 24 },
    exit: { gx: 22, gy: 24, to: 'mainland', spawn: { x: 29, y: 25 } },
    props: [
      { gx: 19, gy: 19, tex: 'roulette_table', opens: 'casino' }, { gx: 24, gy: 19, tex: 'roulette_table', opens: 'casino' },
      { gx: 19, gy: 22, tex: 'blackjack_table', opens: 'casino' }, { gx: 24, gy: 22, tex: 'blackjack_table', opens: 'casino' },
    ],
    dealers: [
      { gx: 19, gy: 18, npc: 'purple', tint: 0x2a2a32 }, { gx: 24, gy: 18, npc: 'purple', tint: 0x2a2a32 },
      { gx: 19, gy: 21, npc: 'boy', tint: 0x2a2a32 }, { gx: 24, gy: 21, npc: 'boy', tint: 0x2a2a32 },
    ],
  },
  wilderness: {
    name: 'Wilderness', biome: 'wild', water: pool(37, 38, 4), spawn: { x: 22, y: 6 },
    resources: { tree: 45, rock: 26, coal: 20 }, shadows: 1, sheds: true,
    bots: { count: 4, anglers: 0, visitors: 0, hunters: 4 },
    enemies: { creeper: 14 },
    structures: [
      { type: 'sign', x: 21, y: 1, to: 'mainland', text: 'SAFE ZONE', color: '#7fff9e', span: 6 },
      { type: 'tombstone', x: 14, y: 18 }, { type: 'tombstone', x: 30, y: 24 },
      { type: 'tombstone', x: 22, y: 32 }, { type: 'tombstone', x: 33, y: 15 },
    ],
  },
};

// ---- enemies & combat -------------------------------------------------------
const ENEMIES = {
  creeper: { name: 'Creeper', tex: 'px_slime', scale: 2.4, hp: 12, dmg: 2, speed: 0.78, xp: 14, aggro: 10, respawn: 9000,
    loot: () => [['coal', Phaser.Math.Between(1, 2)], ['stone', Phaser.Math.Between(0, 2)]] },
  fighter: { name: 'fighter', tex: null, scale: 2.0, hp: 16, dmg: 3, speed: 0.74, xp: 11, aggro: 4.5, respawn: 7000,
    loot: () => [['wood', Phaser.Math.Between(1, 3)], ['stone', Phaser.Math.Between(0, 2)]] },
  // training-ground practice dummy: never moves or hits back, gives a little combat XP, pops back up fast
  dummy:   { name: 'Training Dummy', tex: 'dummy', scale: 1.6, hp: 18, dmg: 0, speed: 0, xp: 3, aggro: 0, respawn: 1400,
    static: true, loot: () => [] },
};
const PLAYER_MAXHP = 30;
const ATTACK_INTERVAL = 0.7;     // seconds between player sword hits

// ---- Fake-player name generator (short, random, gamer-style) ----------------
function randomPlayerName() {
  const cons = 'bcdfghjklmnprstvwz', vow = 'aeiou';
  const syl = Phaser.Math.Between(2, 3);
  let s = '';
  for (let i = 0; i < syl; i++) {
    s += cons[Phaser.Math.Between(0, cons.length - 1)] + vow[Phaser.Math.Between(0, vow.length - 1)];
    if (Math.random() < 0.25) s += cons[Phaser.Math.Between(0, cons.length - 1)];
  }
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (Math.random() < 0.45) s += Phaser.Math.Between(1, 99);
  return s;
}

// =============================================================================
//  Main scene
// =============================================================================
class WorldScene extends Phaser.Scene {
  constructor() { super('world'); }

  preload() {
    // CC0 stylized grassland tiles (OpenGameArt) — 128x64 frames
    this.load.spritesheet('grass_sheet', 'assets/grassland/grass_tiles.png', { frameWidth: 128, frameHeight: 64 });
    this.load.spritesheet('dirt_sheet',  'assets/grassland/dirt_tiles.png',  { frameWidth: 128, frameHeight: 64 });
    this.load.spritesheet('sand_sheet',  'assets/grassland/sand_tiles.png',  { frameWidth: 128, frameHeight: 64 });
    // CC0 stylized tree variants (leafy + dead), pre-trimmed from trees_01
    for (let i = 0; i < 6; i++) this.load.image('tree_g' + i, 'assets/grassland/trees/green_' + i + '.png');
    for (let i = 0; i < 4; i++) this.load.image('tree_b' + i, 'assets/grassland/trees/bare_' + i + '.png');
    // Green slime (creeper) from Kenney "Tiny Dungeon" (CC0)
    this.load.image('px_slime', 'assets/creeper_slime.png');
    // wilderness foliage decor (Kenney Tiny Town, CC0)
    ['mushroom', 'bush', 'bush2'].forEach(k => this.load.image('dec_' + k, 'assets/decor/' + k + '.png'));
    ['log_a', 'log_b', 'logpile'].forEach(k => this.load.image(k, 'assets/decor/' + k + '.png'));   // woodcutter camp decor
    // stone/coal nodes — cartoon "Isometric Rocks" (OpenGameArt, CC-BY 3.0); coal is a darkened variant
    this.load.image('rock', 'assets/nodes/rock.png');
    this.load.image('coal', 'assets/nodes/coal.png');
    // animated campfire (OpenGameArt, CC0) for the Cooking Fire — 4 frames of 32x32
    this.load.spritesheet('campfire', 'assets/campfire.png', { frameWidth: 32, frameHeight: 32 });
    // Casual animated 8-direction characters — AxulArt (CC-BY 4.0). 16x24 frames.
    this.load.spritesheet('axul', 'assets/char_axul.png', { frameWidth: 16, frameHeight: 24 });
    // Pixel weapons (Kenney Tiny Town/Dungeon, CC0; rod hand-drawn) — held & swung by the character
    this.load.image('tool_axe',     'assets/weapons/axe.png');
    this.load.image('tool_pickaxe', 'assets/weapons/pickaxe.png');
    this.load.image('tool_rod',     'assets/weapons/rod.png');
    this.load.image('tool_sword',   'assets/weapons/sword.png');
    // Pixel structures — houses cropped from Kenney Tiny Town (CC0); fountain hand-drawn
    // dark medieval buildings (wilderness ruins)
    this.load.image('house1', 'assets/struct/house1.png');
    this.load.image('house2', 'assets/struct/house2.png');
    this.load.image('house3', 'assets/struct/house3.png');
    // colourful village houses — Isometric Medieval City Sim Assets (OpenGameArt, CC-BY)
    ['cs_house', 'cs_villa', 'cs_tavern', 'cs_inn', 'cs_thatched']
      .forEach(k => this.load.image(k, 'assets/struct/' + k + '.png'));
    this.load.image('fountain', 'assets/struct/fountain.png');
  }

  create() {
    this.makeTextures();
    // keep the pixel-art sprites crisp when scaled up
    ['axul', 'px_slime', 'tool_axe', 'tool_pickaxe', 'tool_rod', 'tool_sword',
     'house1', 'house2', 'house3', 'fountain', 'dec_mushroom', 'dec_bush', 'dec_bush2'].forEach(k => {
      if (this.textures.exists(k)) this.textures.get(k).setFilter(Phaser.Textures.FilterMode.NEAREST);
    });
    this.createCharAnims();
    this.worldOX = (GRID * TILE_W) / 2;
    this.worldOY = TILE_H * 2;

    // persistent objects (survive realm changes)
    this.fishLine = this.add.graphics().setDepth(5000);
    this.playerHpBar = this.add.graphics().setDepth(9002);
    this.guideArrow = this.add.image(0, 0, 'guidearrow').setDepth(99995).setVisible(false);
    this.spawnPlayer();
    this.setupInput();

    this.cameras.main.setBackgroundColor('#0c1430');
    this.cameraFollowing = true;
    this.portalCooldown = 0;
    const halfW = (GRID - 1) * TILE_W / 2, margin = 350;
    const boundsW = halfW * 2 + margin * 2, boundsH = (GRID - 1) * TILE_H + margin * 2;
    this.cameras.main.setBounds(this.worldOX - halfW - margin, this.worldOY - margin, boundsW, boundsH);
    // cap zoom-out so the world keeps filling the view (no dark void around the map)
    const calcMinZoom = () => Math.max(this.scale.width / boundsW, this.scale.height / boundsH, 0.72);
    this.minZoom = calcMinZoom();
    this.scale.on('resize', () => {
      this.minZoom = calcMinZoom();
      const cam = this.cameras.main; if (cam.zoom < this.minZoom) cam.setZoom(this.minZoom);
    });

    // hooks for the HTML HUD / wallet layer
    window.GAME = {
      onLogin: (label, key) => {
        if (this.questGateConnecting) {                    // connecting from the quest gate → migrate current progress, don't wipe it
          this.questGateConnecting = false;
          this.player.saveKey = key;
          if (this.pendingUsername) { this.player.username = this.pendingUsername; this.player.label.setText(this.pendingUsername); }
          this.saveProfile();
          this.closeQuestGate();
        } else {
          this.loadProfile(label, key);
        }
      },
      onLogout: () => this.loadProfile('Guest', 'guest'),
      equip: (id) => this.equipTool(id),
      zoomBy: (d) => this.zoomBy(d),
    };

    this.realm = null;
    this.initBgm();                           // background music (one track per realm)
    this.loadProfile('Guest', 'guest');      // builds the saved (or default) realm
    this.cameras.main.startFollow(this.player.sprite, false, 0.12, 0.12);
    this.bindHotbarClicks();
    this.exportHudIcons();
    this.initBuildingUI();
    // quest done but never connected a wallet → re-show the hard gate (can't be bypassed by reloading)
    if (this.player.questDone && !localStorage.getItem('kintara_last_wallet')) this.showQuestGate();
    else this.startIntroCinematic();          // intro: "Welcome to PixelQuest" camera push-in, holds until you click
  }

  // push generated icons into the HTML HUD <img> slots (replaces emoji)
  exportHudIcons() {
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.src = this.textures.getBase64(key); };
    set('ic-wood', 'ic_wood'); set('ic-stone', 'ic_stone'); set('ic-coal', 'ic_coal'); set('ic-fish', 'ic_fish');
    set('ht-axe', 'tool_axe'); set('ht-pickaxe', 'tool_pickaxe'); set('ht-rod', 'tool_rod'); set('ht-sword', 'tool_sword');
    set('ic-sk-woodcutting', 'tool_axe'); set('ic-sk-mining', 'tool_pickaxe');
    set('ic-sk-fishing', 'tool_rod'); set('ic-sk-combat', 'tool_sword');
  }

  itemIconKey(item) { return { wood: 'ic_wood', stone: 'ic_stone', coal: 'ic_coal', fish: 'ic_fish' }[item]; }

  // floating "+N" with an item icon (used for gathering / fishing / loot)
  floatGain(gx, gy, amount, iconKey) {
    const x = this.worldOX + isoX(gx, gy), y = this.worldOY + isoY(gx, gy) - 30;
    const ic = this.add.image(x - 9, y, iconKey).setDepth(99999).setScale(0.7);
    const t = this.add.text(x + 4, y, '+' + amount, {
      fontSize: '14px', color: '#9fffcb', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 3,
    }).setOrigin(0, 0.5).setDepth(99999);
    this.tweens.add({ targets: [ic, t], y: y - 26, alpha: 0, duration: 850, onComplete: () => { ic.destroy(); t.destroy(); } });
  }

  // =========================================================================
  //  Realms — build / tear down / travel
  // =========================================================================
  buildRealm(id) {
    const cfg = REALMS[id];
    this.realm = id; this.realmCfg = cfg;
    this.realmToken = {};
    this.occupied = new Set();
    this.noSpawn = new Set();
    this.buildGround(cfg);
    if (cfg.interior) {                              // small indoor room — skip the outdoor spawners
      this.structures = []; this.portals = []; this.portalTiles = new Set(); this.forge = null;
      this.resources = []; this.bots = []; this.enemies = []; this.fishShadows = [];
      this.placeBuildings(cfg);
      this.buildInteriorDecor(cfg);
      this.buildMinimap();
      this.updateRealmHUD();
      this.playBgm(id);
      return;
    }
    this.placeStructures(cfg);
    this.placeBuildings(cfg);
    this.createHealAura(cfg);
    this.scatterSheds(cfg);            // wilderness buildings first, at fixed (seeded) spots
    this.resources = [];
    this.spawnResources(cfg);
    this.placeDeadTrees(cfg);
    this.scatterDecor(cfg);
    this.spawnFishShadows(cfg.shadows || 0);
    this.spawnBots(cfg);
    this.spawnEnemies(cfg);
    this.buildMinimap();
    this.updateRealmHUD();
    this.playBgm(id);                  // swap to this realm's track
  }

  clearRealm() {
    this.realmToken = {};                          // invalidate pending respawns
    this.cancelGather(); this.cancelFishing();
    if (this.player) this.clearCombat();
    (this.tiles || []).forEach(t => t.destroy());
    (this.resources || []).forEach(r => { if (r.shake) r.shake.stop(); r.sprite.destroy(); });
    (this.bots || []).forEach(b => {
      if (b.fish) { if (b.fish.bobber) b.fish.bobber.destroy(); if (b.fish.line) b.fish.line.destroy(); }
      if (b.tool) b.tool.destroy();
      b.sprite.destroy(); b.label.destroy();
    });
    (this.enemies || []).forEach(e => { e.sprite.destroy(); if (e.label) e.label.destroy(); if (e.hpbar) e.hpbar.destroy(); });
    (this.fishShadows || []).forEach(f => f.sprite.destroy());
    (this.structures || []).forEach(s => { if (s.sprite) s.sprite.destroy(); if (s.label) s.label.destroy(); });
    if (this.arenaRopes) { this.arenaRopes.destroy(); this.arenaRopes = null; }
    if (this.healAura) { this.healAura.destroy(); this.healAura = null; }
    if (this.mmBase) this.mmBase.destroy();
    if (this.mmDots) this.mmDots.destroy();
    this.tiles = []; this.tileIndex = {}; this.waterTiles = [];
    this.resources = []; this.bots = []; this.enemies = []; this.fishShadows = [];
    this.structures = []; this.portals = []; this.portalTiles = new Set(); this.forge = null;
    this.buildings = []; this.buildingPortals = [];
  }

  travelTo(id, spawnOverride) {
    const cam = this.cameras.main;
    this.portalCooldown = 1.2;
    cam.fadeOut(200, 6, 12, 26);
    cam.once('camerafadeoutcomplete', () => {
      this.clearRealm();
      this.buildRealm(id);
      const sp = spawnOverride || REALMS[id].spawn;
      this.player.gx = sp.x; this.player.gy = sp.y; this.player.path = [];
      this.placeEntity(this.player);
      cam.centerOn(this.player.sprite.x, this.player.sprite.y);
      this.cameraFollowing = true;
      cam.startFollow(this.player.sprite, false, 0.12, 0.12);
      this.portalCooldown = 1.0;
      this.saveProfile();
      this.toast('Entered ' + REALMS[id].name, 'level');
      cam.fadeIn(220, 6, 12, 26);
    });
  }

  updatePortals(dt) {
    if (this.portalCooldown > 0) { this.portalCooldown -= dt; return; }
    if (this.dlgOpen || this.modalOpen) return;
    for (const p of this.portals) {
      if (Math.hypot(p.gx - this.player.gx, p.gy - this.player.gy) < 0.7) {
        if (p.danger && !this.player.warnedWild) { this.confirmWildEntry(p); return; }   // first-time warning
        this.travelTo(p.to); return;
      }
    }
  }

  // ground entry arrows in front of buildings: glow green when you're close, open
  // the building when you step on, and re-arm once you walk back off.
  updateBuildingPortals(dt) {
    for (const bp of (this.buildingPortals || [])) {
      const d = Math.hypot(bp.gx - this.player.gx, bp.gy - this.player.gy);
      const near = d < 1.6;
      bp.t += dt;
      bp.sprite.setTint(near ? 0x7cffa0 : 0x8aa0bf);                            // green when close, muted otherwise
      bp.sprite.setAlpha(near ? 0.85 + Math.sin(bp.t * 5) * 0.15 : 0.5);        // engraved arrow breathes
      if (bp.hi) bp.hi.setAlpha(near ? 0.28 + Math.sin(bp.t * 5) * 0.1 : 0);    // green tile glow when close
      if (d < 0.6) {
        if (bp.armed && !this.modalOpen && !this.dlgOpen && this.portalCooldown <= 0) {
          bp.armed = false; this.player.path = [];
          if (bp.to) this.travelTo(bp.to, bp.spawn); else this.openBuilding(bp.b);   // enter a room, or open the panel
        }
      } else if (d > 1.2) {
        bp.armed = true;
      }
    }
  }

  // clicking an entry arrow: only if you're nearby, walk onto it — arrival triggers
  // the step-on logic in updateBuildingPortals (enter room / open panel). Far click does nothing.
  onEntryArrowClick(bp) {
    if (Math.hypot(bp.gx - this.player.gx, bp.gy - this.player.gy) > 5) return;   // too far away
    this.cancelGather(); this.cancelFishing(); this.clearCombat();
    this.pendingBuilding = null;
    this.moveTo(bp.gx, bp.gy, true);
  }

  // first time stepping into the danger zone: warn that death there wipes everything carried
  confirmWildEntry(p) {
    this.portalCooldown = 1.0; this.player.path = [];
    this.dialogue('⚠ Danger Zone',
      "Beyond here is the Wilderness. Die out there and you lose EVERYTHING in your backpack and hotbar — tools and all. Only what's in your Bank is safe. Tip: deposit your resources at the Bank before you fight.",
      [
        { label: "I'm ready", fn: () => { this.player.warnedWild = true; this.saveProfile(); this.closeDialogue(); this.travelTo(p.to); } },
        { label: 'Not ready yet', fn: () => {
          this.closeDialogue();
          this.player.gx = Math.max(1, p.gx - 2); this.player.path = [];   // step back into the safe zone
          this.placeEntity(this.player); this.portalCooldown = 1.0;
        } },
      ]);
  }

  updateRealmHUD() {
    const rn = document.getElementById('realm-name');
    if (rn) rn.textContent = this.realmCfg.name;
    if (this.onlineCount == null) this.initOnlineTicker();      // start the slow population climb once
    const oc = document.getElementById('online-count');
    if (oc) oc.textContent = this.onlineCount;
  }

  // fake "players online": drifts slowly up from 8 to 30, then only tiny wobble (no big drops)
  initOnlineTicker() {
    this.onlineCount = 8;
    this.time.addEvent({ delay: 2600, loop: true, callback: () => {
      let n = this.onlineCount;
      if (n < 30) {
        const r = Math.random();
        if (r < 0.72) n += Phaser.Math.Between(1, 2);          // mostly climb
        else if (r < 0.9) n += 0;                              // hold
        else n -= 1;                                           // small dip
        n = Phaser.Math.Clamp(n, 8, 30);
      } else {
        n = 30 - (Math.random() < 0.35 ? 1 : 0);               // settled: 29–30 only
      }
      this.onlineCount = n;
      const oc = document.getElementById('online-count');
      if (oc) oc.textContent = n;
    } });
  }

  // =========================================================================
  //  Background music — one looping track per realm (HTML5 streaming audio)
  // =========================================================================
  initBgm() {
    const make = src => { const a = new Audio(src); a.loop = true; a.preload = 'auto'; a.volume = 0; return a; };
    const savedMusic = parseFloat(localStorage.getItem('kintara_music_vol'));
    const savedSound = parseFloat(localStorage.getItem('kintara_sound_vol'));
    this.bgm = { tracks: { mainland: make('music/mainland.mp3'), wilderness: make('music/wilderness.mp3') },
      cur: null, want: null,
      vol: isNaN(savedMusic) ? 0.45 : savedMusic,           // music volume 0..1
      soundVol: isNaN(savedSound) ? 0.7 : savedSound };      // game SFX volume (wired up later)
    // browsers block autoplay until a user gesture — start on the first one
    const unlock = () => { this.bgm.unlocked = true; this.initSfx(); if (this.bgm.want) this.playBgm(this.bgm.want); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    this.addSettingsButton();
  }

  playBgm(realm) {
    const b = this.bgm; if (!b) return;
    b.want = realm;
    if (!b.unlocked) return;                      // wait for the first user gesture
    const next = b.tracks[realm]; if (!next) return;
    const prev = b.cur;                           // capture before reassign — callback fires later
    if (prev && prev !== next) this.fadeAudio(prev, 0, () => prev.pause());
    b.cur = next;
    if (b.vol <= 0) { next.pause(); next.volume = 0; return; }
    next.play().catch(() => {});                  // ignore autoplay rejections
    this.fadeAudio(next, b.vol);
  }

  fadeAudio(a, to, done) {
    if (a._fade) clearInterval(a._fade);
    const step = (to - a.volume) / 18 || 0;
    if (step === 0) { a.volume = to; if (done) done(); return; }
    a._fade = setInterval(() => {
      a.volume = Math.min(1, Math.max(0, a.volume + step));
      if (Math.abs(a.volume - to) < 0.03) { a.volume = to; clearInterval(a._fade); a._fade = null; if (done) done(); }
    }, 30);
  }

  // ---- procedural SFX (Web Audio, no asset files) ---------------------------
  initSfx() {
    if (this.actx) { if (this.actx.state === 'suspended') this.actx.resume(); return; }
    try { this.actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { this.actx = null; return; }
    this.sfxMaster = this.actx.createGain();
    this.sfxMaster.gain.value = this.bgm ? this.bgm.soundVol : 0.7;
    this.sfxMaster.connect(this.actx.destination);
  }

  // name → a short synthesized blip. cheap, snappy, retro.
  sfx(name) {
    const ac = this.actx, master = this.sfxMaster;
    if (!ac || !master) return;
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime;
    const tone = (f, dur, type = 'triangle', g = 0.3, f2 = null, delay = 0) => {
      const t = now + delay, o = ac.createOscillator(), ga = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      ga.gain.setValueAtTime(g, t); ga.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(ga); ga.connect(master); o.start(t); o.stop(t + dur + 0.02);
    };
    const noise = (dur, g = 0.3, type = 'lowpass', freq = 1200, delay = 0) => {
      const t = now + delay, len = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ac.createBufferSource(); src.buffer = buf;
      const filt = ac.createBiquadFilter(); filt.type = type; filt.frequency.value = freq;
      const ga = ac.createGain(); ga.gain.setValueAtTime(g, t); ga.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      src.connect(filt); filt.connect(ga); ga.connect(master); src.start(t); src.stop(t + dur + 0.02);
    };
    switch (name) {
      case 'chop':  tone(150, 0.13, 'square', 0.22, 80); noise(0.10, 0.22, 'lowpass', 700); break;
      case 'mine':  tone(440, 0.10, 'square', 0.15, 240); noise(0.08, 0.28, 'highpass', 2000); break;
      case 'cast':  tone(680, 0.20, 'sine', 0.22, 180); noise(0.12, 0.10, 'lowpass', 500, 0.05); break;
      case 'catch': tone(560, 0.09, 'sine', 0.28, null, 0); tone(840, 0.16, 'sine', 0.28, 1100, 0.09); break;
      case 'hit':   noise(0.12, 0.32, 'lowpass', 1100); tone(120, 0.10, 'square', 0.18, 60); break;
      case 'down':  tone(300, 0.28, 'sawtooth', 0.22, 70); break;
      case 'level': tone(523, 0.12, 'triangle', 0.26, null, 0); tone(659, 0.12, 'triangle', 0.26, null, 0.11); tone(784, 0.20, 'triangle', 0.28, null, 0.22); break;
      case 'pickup':tone(880, 0.07, 'sine', 0.22, 1240); break;
      case 'ui':    tone(440, 0.04, 'sine', 0.14); break;
      case 'talk':  { const f = 380 + Math.random() * 150; tone(f, 0.05, 'square', 0.05, f * 0.8); break; }   // soft text blip
    }
  }

  // live music-volume change from the settings slider (0..1)
  setMusicVolume(v) {
    const b = this.bgm; if (!b) return;
    b.vol = v;
    localStorage.setItem('kintara_music_vol', String(v));
    if (v <= 0) { if (b.cur) { if (b.cur._fade) clearInterval(b.cur._fade); b.cur.volume = 0; b.cur.pause(); } return; }
    if (b.cur) { if (b.cur._fade) clearInterval(b.cur._fade); b.cur.volume = v; if (b.cur.paused) b.cur.play().catch(() => {}); }
    else if (b.unlocked && b.want) this.playBgm(b.want);
  }

  setSoundVolume(v) {
    const b = this.bgm; if (!b) return;
    b.soundVol = v;
    localStorage.setItem('kintara_sound_vol', String(v));
    if (this.sfxMaster) this.sfxMaster.gain.value = v;
  }

  addSettingsButton() {
    if (document.getElementById('hud-settings')) return;
    const btn = document.createElement('button');
    btn.id = 'hud-settings';
    btn.innerHTML = `<img src="${this.texB64('ic_gear')}" width="22" height="22" style="image-rendering:pixelated;">`;
    btn.title = 'Settings';
    btn.style.cssText = 'position:absolute;right:16px;bottom:16px;z-index:12;width:42px;height:42px;border-radius:50%;' +
      'background:var(--panel);border:1px solid var(--panel-border);color:#cfd6ff;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(0,0,0,.45);';
    btn.onmouseenter = () => btn.style.borderColor = '#4a559a';
    btn.onmouseleave = () => btn.style.borderColor = 'var(--panel-border)';
    btn.onclick = () => this.panelSettings();
    document.body.appendChild(btn);
  }

  panelSettings() {
    const b = this.bgm || { vol: 0.45, soundVol: 0.7 };
    const pct = v => Math.round(v * 100);
    const slider = (id, label, val, disabled) => `
      <div class="kset-row${disabled ? ' kset-soon' : ''}">
        <div class="kset-top"><span>${label}</span><span class="kset-val" id="${id}-val">${pct(val)}%${disabled ? ' · soon' : ''}</span></div>
        <input type="range" class="kset-slider" id="${id}" min="0" max="100" value="${pct(val)}"${disabled ? ' disabled' : ''}>
      </div>`;
    const body = `
      <style>
        .kset-row{padding:12px 0;border-top:1px solid #222b53;}
        .kset-row:first-child{border-top:none;}
        .kset-top{display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px;color:#d7ddff;}
        .kset-val{color:var(--good);font-weight:700;}
        .kset-soon{opacity:.5;}
        .kset-slider{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:4px;
          background:#10173a;border:1px solid #232c5a;outline:none;cursor:pointer;}
        .kset-slider:disabled{cursor:default;}
        .kset-slider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;
          background:linear-gradient(135deg,var(--accent),var(--accent2));border:2px solid #0b1024;cursor:pointer;}
        .kset-slider::-moz-range-thumb{width:18px;height:18px;border-radius:50%;border:2px solid #0b1024;
          background:#7c5cff;cursor:pointer;}
      </style>
      ${slider('set-music', this.ico('ic_music', 16) + ' Music', b.vol, false)}
      ${slider('set-sound', this.ico('ic_sound', 16) + ' Game Sound', b.soundVol, false)}
      <button class="kbtn alt" id="set-keys" style="width:100%;margin-top:18px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px;">${this.ico('ic_keys', 16)} View Keybinds</button>`;
    this.showPanel(this.ico('ic_gear', 20) + ' Settings', 'Adjust your audio.', body, card => {
      const m = card.querySelector('#set-music'), mv = card.querySelector('#set-music-val');
      if (m) m.oninput = () => { const v = m.value / 100; mv.textContent = m.value + '%'; this.setMusicVolume(v); };
      const s = card.querySelector('#set-sound'), sv = card.querySelector('#set-sound-val');
      if (s) s.oninput = () => { const v = s.value / 100; sv.textContent = s.value + '%'; this.setSoundVolume(v); this.sfx('ui'); };
      const k = card.querySelector('#set-keys');
      if (k) k.onclick = () => { this.sfx('ui'); this.panelKeybinds(); };
    });
  }

  // inline <img> for a generated icon texture (game-art replacements for emoji/svg)
  ico(key, s = 16) { return `<img src="${this.texB64(key)}" width="${s}" height="${s}" style="vertical-align:middle;image-rendering:pixelated;margin-right:2px;">`; }

  panelKeybinds() {
    const rows = [
      ['Move (or Arrow keys)', 'W A S D'],
      ['Move · interact', 'Left-click'],
      ['Pan camera', 'Drag'],
      ['Recenter camera', 'C'],
      ['Zoom in / out', 'Scroll'],
      ['Equip Axe · Pickaxe · Rod · Sword', '1 2 3 4'],
      ['Interact · enter building', 'E'],
      ['Upgrade equipped tool', 'U'],
      ['Open world map (or click minimap)', 'M'],
      ['Cinematic / trailer mode', 'T'],
    ];
    const keyChip = s => s.split(' ').map(k => /^[A-Za-z0-9+\-]+$/.test(k) ? `<kbd class="kkbd">${k}</kbd>` : `<span style="color:#8a93c4;">${k}</span>`).join(' ');
    const body = `<style>.kkbd{display:inline-block;background:#1a2147;border:1px solid #3a4680;border-bottom-width:2px;
      border-radius:5px;padding:1px 7px;font-size:12px;font-weight:700;color:#dfe6ff;font-family:ui-monospace,monospace;}</style>` +
      rows.map(([a, k]) => `<div class="krow"><span>${a}</span><span style="display:flex;gap:4px;align-items:center;">${keyChip(k)}</span></div>`).join('') +
      `<button class="kbtn alt" id="kb-back" style="width:100%;margin-top:16px;">← Back to Settings</button>`;
    this.showPanel(this.ico('ic_keys', 20) + ' Keybinds', 'Controls reference', body, card => {
      const b = card.querySelector('#kb-back'); if (b) b.onclick = () => { this.sfx('ui'); this.panelSettings(); };
    });
  }

  // ---- directional character animation --------------------------------------
  createCharAnims() {
    for (const [name, base] of Object.entries(AXUL_ROW)) {
      for (let c = 0; c < 8; c++) {
        const f0 = base * AXUL_COLS + c, f1 = f0 + AXUL_COLS, f2 = f1 + AXUL_COLS;
        if (!this.anims.exists(name + '_idle_' + c))
          this.anims.create({ key: name + '_idle_' + c, frameRate: 1, repeat: -1,
            frames: [{ key: 'axul', frame: f0 }] });
        if (!this.anims.exists(name + '_walk_' + c))
          this.anims.create({ key: name + '_walk_' + c, frameRate: 8, repeat: -1,
            frames: [f1, f0, f2, f0].map(f => ({ key: 'axul', frame: f })) });
      }
    }
    if (!this.anims.exists('campfire'))
      this.anims.create({ key: 'campfire', frameRate: 8, repeat: -1,
        frames: this.anims.generateFrameNumbers('campfire', { start: 0, end: 3 }) });
  }

  octant(dx, dy) {   // screen-movement octant from a grid (dx,dy)
    return ((Math.round(Math.atan2(dx + dy, dx - dy) / (Math.PI / 4)) % 8) + 8) % 8;
  }

  // turn an entity to face a (dx,dy) direction: directional -> animation column, else flip
  faceDir(e, dx, dy) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    if (e.directional) e.facingCol = AXUL_DIR_COLS[this.octant(dx, dy)];
    else if (Math.abs(dx - dy) > 0.001) e.sprite.setFlipX((dx - dy) < 0);
  }

  // picks the right 8-way facing + walk/idle clip from the entity's per-frame movement
  updateDirAnim(e) {
    if (!e || !e.directional || !e.sprite || !e.sprite.anims) return;
    if (e._pgx === undefined) { e._pgx = e.gx; e._pgy = e.gy; }
    const dgx = e.gx - e._pgx, dgy = e.gy - e._pgy;
    e._pgx = e.gx; e._pgy = e.gy;
    const moving = Math.hypot(dgx, dgy) > 0.0015;
    if (moving) e.facingCol = AXUL_DIR_COLS[this.octant(dgx, dgy)];
    if (e.facingCol === undefined) e.facingCol = AXUL_DIR_S;
    const want = (e.animSet || 'boy') + (moving ? '_walk_' : '_idle_') + e.facingCol;
    if (e.sprite.anims.getName() !== want) e.sprite.play(want, true);
  }

  // ---- generated art --------------------------------------------------------
  makeTextures() {
    const g = this.add.graphics();

    const tile = (key, top) => {
      g.clear();
      g.fillStyle(top, 1);
      g.beginPath();
      g.moveTo(TILE_W / 2, 0); g.lineTo(TILE_W, TILE_H / 2);
      g.lineTo(TILE_W / 2, TILE_H); g.lineTo(0, TILE_H / 2); g.closePath(); g.fillPath();
      g.lineStyle(1, top, 1); g.strokePath();   // same colour as fill → no visible grid line, no seams
      g.generateTexture(key, TILE_W, TILE_H);
    };
    tile('gA', 0x3f8a4a, 0x356f3f);          // grass biome
    tile('gB', 0x387f44, 0x2f6539);
    tile('water', 0x2f74b8, 0x215a93);
    tile('sand',  0xc9b079, 0xb39a63);
    tile('wA', 0x4a4438, 0x39342b);          // wilderness biome (ashen)
    tile('wB', 0x433d33, 0x322e26);
    tile('wwater', 0x3a4a55, 0x2b3942);      // murky water
    tile('wsand', 0x6b5d44, 0x564a36);
    tile('arena', 0xc3ccd6, 0xc3ccd6);       // light canvas mat for the PvP ring
    tile('plaza', 0x9098a3, 0x9098a3);       // cobblestone plaza around the fountain
    tile('hi',    0xffffff, 0xffffff);   // hover highlight (used with low alpha)

    // light sky-blue water tile — flat fill so the pond reads as one continuous
    // surface (no per-tile bubbles/grid); motion comes from the runtime shimmer + ripples
    g.clear();
    g.fillStyle(0x6cbcef, 1);                                   // sky-blue
    g.beginPath();
    g.moveTo(TILE_W / 2, -0.5); g.lineTo(TILE_W + 0.5, TILE_H / 2);
    g.lineTo(TILE_W / 2, TILE_H + 0.5); g.lineTo(-0.5, TILE_H / 2); g.closePath(); g.fillPath();
    g.generateTexture('water_lit', TILE_W, TILE_H);

    // tree
    g.clear();
    g.fillStyle(0x000000, 0.18); g.fillEllipse(24, 56, 30, 9);
    g.fillStyle(0x5a3a1e, 1); g.fillRect(20, 36, 8, 20);
    g.fillStyle(0x2e7d32, 1); g.fillCircle(24, 24, 18);
    g.fillStyle(0x3aa346, 1); g.fillCircle(16, 18, 11); g.fillCircle(33, 21, 10);
    g.fillStyle(0x49bd57, 0.8); g.fillCircle(20, 14, 7);
    g.generateTexture('tree', 48, 62);

    // (rock & coal are loaded as CC-BY cartoon-rock images in preload)

    // fish shadow (ambient, swims in the pond)
    g.clear();
    g.fillStyle(0x0a2230, 1);
    g.fillEllipse(11, 6, 17, 7);
    g.fillTriangle(18, 6, 24, 2, 24, 10);
    g.generateTexture('fish_shadow', 26, 12);

    // bobber (float on the water while fishing)
    g.clear();
    g.fillStyle(0xff4d4d, 1); g.fillCircle(6, 6, 4.5);
    g.fillStyle(0xffffff, 1); g.fillRect(1.5, 6, 9, 3);
    g.lineStyle(1, 0x10142b, 0.4); g.strokeCircle(6, 6, 4.5);
    g.fillStyle(0x10142b, 1); g.fillCircle(6, 1.5, 1);            // antenna tip
    g.generateTexture('bobber', 13, 14);

    // caught fish (reeled in on the line)
    g.clear();
    g.fillStyle(0xbfe6f2, 1); g.fillEllipse(11, 6, 16, 8);
    g.fillStyle(0x8fc9dc, 1); g.fillTriangle(17, 6, 23, 1, 23, 11);
    g.fillStyle(0x8fc9dc, 0.85); g.fillTriangle(9, 6, 14, 3, 14, 9);
    g.fillStyle(0x10384a, 1); g.fillCircle(6, 5, 1.4);           // eye
    g.generateTexture('fish_caught', 24, 12);

    // forge / anvil station (covers a 2x2 footprint)
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(48, 78, 80, 16);
    g.fillStyle(0x6b4a2a, 1); g.fillRoundedRect(8, 46, 80, 28, 5);    // wood platform
    g.fillStyle(0x3a3f4b, 1); g.fillRoundedRect(12, 40, 40, 26, 5);   // furnace base
    g.fillStyle(0x2b2f38, 1); g.fillRect(18, 46, 28, 14);            // coal bed
    g.fillStyle(0xff8a3d, 1); g.fillCircle(32, 52, 7);               // ember
    g.fillStyle(0xffd07a, 0.95); g.fillCircle(32, 52, 4);
    g.fillStyle(0x4b515f, 1); g.fillRoundedRect(54, 40, 32, 16, 4);   // anvil body
    g.fillStyle(0x5c6373, 1); g.fillTriangle(82, 40, 92, 44, 82, 50); // anvil horn
    g.generateTexture('forge', 96, 84);

    // (house1/2/3 and fountain are loaded as pixel images in preload)

    // portal (glowing arch)
    g.clear();
    g.fillStyle(0x4b515f, 1); g.fillRoundedRect(4, 8, 36, 48, 18);
    g.fillStyle(0x0c1430, 1); g.fillRoundedRect(9, 13, 26, 42, 13);
    g.fillStyle(0x7c5cff, 0.9); g.fillEllipse(22, 34, 20, 34);
    g.fillStyle(0xb39bff, 0.7); g.fillEllipse(22, 34, 11, 21);
    g.fillStyle(0xe6dbff, 0.85); g.fillEllipse(22, 31, 5, 11);
    g.generateTexture('portal', 44, 62);

    // bonfire / roast pit (covers a 2x2 area — campfire with a grill & pot)
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(44, 66, 72, 14);
    g.fillStyle(0x6b727c, 1);                                          // stone ring
    [[18, 56], [30, 60], [44, 61], [58, 60], [70, 56]].forEach(([x, y]) => g.fillCircle(x, y, 5));
    g.fillStyle(0x5a3a1e, 1); g.fillRect(20, 48, 48, 10); g.fillStyle(0x6b4a2a, 1); g.fillRect(24, 52, 40, 7); // logs
    g.fillStyle(0xff8a3d, 1); g.fillTriangle(28, 54, 44, 16, 60, 54);  // flame
    g.fillStyle(0xffd07a, 1); g.fillTriangle(34, 54, 44, 26, 54, 54);
    g.lineStyle(3, 0x2b2b33, 1); g.lineBetween(22, 52, 22, 30); g.lineBetween(66, 52, 66, 30); g.lineBetween(20, 32, 68, 32); // grill
    g.fillStyle(0xcfd6df, 1); g.fillEllipse(44, 30, 16, 8); g.fillStyle(0x9aa3ad, 1); g.fillEllipse(44, 28, 16, 7); // pot
    g.generateTexture('roastpit', 88, 76);

    // tombstone
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(16, 37, 26, 8);
    g.fillStyle(0x6b727c, 1); g.fillRoundedRect(7, 9, 18, 28, 8);
    g.fillStyle(0x565d66, 1); g.fillRect(7, 22, 18, 15);
    g.fillStyle(0x3f4550, 1); g.fillRect(14, 15, 3, 12); g.fillRect(10, 18, 12, 3);  // cross
    g.generateTexture('tombstone', 32, 42);

    // sign / billboard (big Hollywood-style poster on posts, with an arrow)
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(48, 80, 62, 12);
    g.fillStyle(0x4a3320, 1); g.fillRect(22, 44, 7, 36); g.fillRect(67, 44, 7, 36);   // posts
    g.fillStyle(0x9a6a32, 1); g.fillRoundedRect(8, 12, 80, 40, 5);                    // board
    g.fillStyle(0x7d5326, 1); g.fillRect(8, 44, 80, 8);                               // board shade
    g.fillStyle(0xf0d68a, 1); g.fillRect(14, 18, 68, 5); g.fillRect(14, 42, 68, 4);   // accent stripes
    g.fillStyle(0xd23b3b, 1); g.fillTriangle(78, 16, 94, 32, 78, 48);                 // red arrow
    g.lineStyle(2, 0x2e1f10, 0.5); g.strokeRoundedRect(8, 12, 80, 40, 5);
    g.generateTexture('sign', 96, 84);

    // danger sign — red board with a painted skull (no emoji)
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(48, 80, 62, 12);
    g.fillStyle(0x4a3320, 1); g.fillRect(22, 44, 7, 36); g.fillRect(67, 44, 7, 36);   // posts
    g.fillStyle(0x8f2f2f, 1); g.fillRoundedRect(8, 10, 80, 44, 5);                     // red board
    g.fillStyle(0x6f2222, 1); g.fillRect(8, 44, 80, 10);
    g.fillStyle(0xf1ede2, 1); g.fillCircle(48, 28, 13); g.fillRoundedRect(40, 33, 16, 11, 4);  // skull head + jaw
    g.fillStyle(0x2a1212, 1); g.fillCircle(43, 27, 3.6); g.fillCircle(53, 27, 3.6);    // eye sockets
    g.fillTriangle(48, 30, 45.5, 34, 50.5, 34);                                        // nose
    g.fillStyle(0x8f2f2f, 1); g.fillRect(44, 40, 1.6, 4); g.fillRect(48, 40, 1.6, 4); g.fillRect(52, 40, 1.6, 4); // teeth gaps
    g.lineStyle(2, 0x2e1010, 0.5); g.strokeRoundedRect(8, 10, 80, 44, 5);
    g.generateTexture('sign_danger', 96, 84);

    // fence post (WWE-ring style rails for the arena)
    g.clear();
    g.fillStyle(0x000000, 0.18); g.fillEllipse(16, 36, 18, 5);
    g.fillStyle(0x6b4a2a, 1); g.fillRect(13, 8, 6, 28);                               // post
    g.fillStyle(0x8a6234, 1); g.fillRect(0, 14, 32, 4); g.fillRect(0, 23, 32, 4);     // two rails
    g.fillStyle(0xd9a441, 1); g.fillRect(0, 14, 32, 1.2); g.fillRect(0, 23, 32, 1.2); // rail highlight
    g.generateTexture('fence', 32, 40);

    // ring post (WWE turnbuckle) for the PvP arena corners
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(8, 50, 16, 5);
    g.fillStyle(0xcfd3da, 1); g.fillRect(5, 12, 6, 38);                               // steel post
    g.fillStyle(0x9aa0aa, 1); g.fillRect(5, 12, 2, 38);                              // post shade
    g.fillStyle(0xd23b3b, 1); g.fillRoundedRect(2, 3, 12, 12, 3);                     // red turnbuckle pad
    g.fillStyle(0xe85a5a, 1); g.fillRoundedRect(3, 4, 10, 5, 2);                      // pad highlight
    g.generateTexture('ringpost', 16, 54);

    // HUD item icons (no emoji) — 24x24
    g.clear();
    g.fillStyle(0x000000, 0.18); g.fillEllipse(12, 21, 18, 4);
    g.fillStyle(0x6b4a2a, 1); g.fillRoundedRect(3, 8, 18, 9, 3);
    g.fillStyle(0xc69a63, 1); g.fillEllipse(5, 12.5, 6, 9); g.fillStyle(0x8a6a3a, 1); g.fillEllipse(5, 12.5, 3.4, 6);
    g.generateTexture('ic_wood', 24, 24);

    const oreIcon = (key, body, hi, glint) => {
      g.clear();
      g.fillStyle(0x000000, 0.18); g.fillEllipse(12, 21, 18, 4);
      g.fillStyle(body, 1);
      g.beginPath(); g.moveTo(4, 16); g.lineTo(8, 7); g.lineTo(16, 6); g.lineTo(20, 14); g.lineTo(16, 19); g.lineTo(7, 19); g.closePath(); g.fillPath();
      g.fillStyle(hi, 1); g.fillTriangle(8, 7, 16, 6, 12, 12);
      if (glint) { g.fillStyle(glint, 0.9); g.fillCircle(10, 13, 1.2); g.fillCircle(15, 10, 1); }
      g.generateTexture(key, 24, 24);
    };
    oreIcon('ic_stone', 0x9aa3ad, 0xb7bfc8, null);
    oreIcon('ic_coal', 0x33363f, 0x4a4e59, 0x9fd0ff);

    g.clear();
    g.fillStyle(0x000000, 0.15); g.fillEllipse(12, 21, 16, 4);
    g.fillStyle(0xbfe6f2, 1); g.fillEllipse(11, 12, 16, 8);
    g.fillStyle(0x8fc9dc, 1); g.fillTriangle(18, 12, 23, 7, 23, 17);
    g.fillStyle(0x10384a, 1); g.fillCircle(7, 11, 1.4);
    g.generateTexture('ic_fish', 24, 24);

    // creeper (wilderness mob)
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(16, 43, 24, 8);
    g.fillStyle(0x3c9a45, 1); g.fillRoundedRect(7, 10, 18, 32, 4);                    // body
    g.fillStyle(0x49bd57, 1); g.fillRect(7, 10, 18, 14);                              // head lighter
    g.fillStyle(0x123018, 1); g.fillRect(11, 14, 4, 5); g.fillRect(18, 14, 4, 5);     // eyes
    g.fillStyle(0x123018, 1); g.fillRect(14, 20, 5, 8); g.fillRect(12, 24, 3, 5); g.fillRect(18, 24, 3, 5); // mouth
    g.fillStyle(0x2e7d39, 1); g.fillRect(9, 42, 6, 5); g.fillRect(18, 42, 6, 5);      // feet
    g.generateTexture('creeper', 32, 48);

    // (tool_axe/pickaxe/rod/sword are loaded as pixel weapon images in preload)

    // character (origin bottom-center; tinted per entity). Baked light/dark shading
    // so a single setTint() colours the whole figure while eyes/belt/boots stay dark.
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(16, 46, 22, 7);                 // ground shadow
    // legs + boots
    g.fillStyle(0xcfcfcf, 1); g.fillRect(11, 33, 4.5, 11); g.fillRect(16.5, 33, 4.5, 11);
    g.fillStyle(0x000000, 0.18); g.fillRect(16.5, 33, 4.5, 11);                // right leg shade
    g.fillStyle(0x2b2b2b, 1); g.fillRoundedRect(10, 42, 6.5, 4.5, 1.5); g.fillRoundedRect(15.5, 42, 6.5, 4.5, 1.5);
    // arms
    g.fillStyle(0xe2e2e2, 1); g.fillRoundedRect(4.5, 20, 5, 13, 2.5); g.fillRoundedRect(22.5, 20, 5, 13, 2.5);
    g.fillStyle(0x000000, 0.16); g.fillRoundedRect(22.5, 20, 5, 13, 2.5);
    // torso / tunic
    g.fillStyle(0xffffff, 1); g.fillRoundedRect(8, 19, 16, 17, 5);
    g.fillStyle(0x000000, 0.13); g.fillRoundedRect(16.5, 19, 7.5, 17, 5);      // right-side shade
    g.fillStyle(0xffffff, 0.5); g.fillRoundedRect(9, 20, 4, 14, 2);            // left highlight
    g.fillStyle(0x2b2b2b, 1); g.fillRect(8, 31, 16, 3);                        // belt
    g.fillStyle(0xffd76b, 1); g.fillRect(14.3, 31, 3.4, 3);                    // buckle
    // head
    g.fillStyle(0xf4efe8, 1); g.fillCircle(16, 11, 7.5);                       // lightest = face
    g.fillStyle(0x000000, 0.10); g.fillEllipse(18, 13, 11, 6);                 // jaw shade
    g.fillStyle(0x000000, 0.40); g.fillEllipse(16, 6.5, 16, 8.5);              // hair
    g.fillStyle(0x000000, 0.40); g.fillRect(8.6, 6, 14.8, 4);
    g.fillStyle(0x1b1b1b, 1); g.fillCircle(13.4, 11, 1.4); g.fillCircle(18.6, 11, 1.4);  // eyes
    g.generateTexture('char', 32, 48);

    // (tool_axe / tool_pickaxe / tool_rod are loaded as pixel weapon images in preload)

    // spark (mining impact) — tinted per use
    g.clear();
    g.fillStyle(0xffffff, 1); g.fillCircle(3, 3, 2.4);
    g.generateTexture('spark', 6, 6);

    // leaf (shaken loose when chopping)
    g.clear();
    g.fillStyle(0x49bd57, 1); g.fillEllipse(3, 2.5, 5, 3);
    g.fillStyle(0x2e7d32, 1); g.fillRect(2.6, 1, 0.8, 3);
    g.generateTexture('leaf', 6, 5);

    // faceted stone & coal chunks (debris that crumbles off when mining)
    const chunk = (key, outline, body, shadow, highlight) => {
      g.clear();
      g.fillStyle(outline, 1);
      g.beginPath(); g.moveTo(1, 5); g.lineTo(4, 1); g.lineTo(8, 2);
      g.lineTo(11, 6); g.lineTo(8, 10); g.lineTo(3, 9); g.closePath(); g.fillPath();
      g.fillStyle(body, 1);
      g.beginPath(); g.moveTo(2.3, 5); g.lineTo(4.4, 2.3); g.lineTo(7.8, 3.2);
      g.lineTo(9.8, 6); g.lineTo(7.2, 8.7); g.lineTo(3.4, 7.6); g.closePath(); g.fillPath();
      g.fillStyle(shadow, 1); g.fillTriangle(9.8, 6, 7.2, 8.7, 7.8, 3.2);   // lower-right facet
      g.fillStyle(highlight, 1); g.fillTriangle(4.4, 2.3, 2.3, 5, 5.4, 4.6); // upper-left facet
      g.generateTexture(key, 12, 11);
    };
    chunk('pebble', 0x20242e, 0x99a1ab, 0x767e88, 0xc4ccd4);
    chunk('pebble_coal', 0x111419, 0x3a3f4b, 0x2a2e38, 0x586070);

    // building badge icons (white line-art, drawn so they always render)
    g.clear(); g.lineStyle(2.6, 0xffffff, 1);
    g.beginPath(); g.moveTo(4, 12); g.lineTo(15, 5); g.lineTo(26, 12); g.strokePath();   // bank roof
    g.fillStyle(0xffffff, 1);[7, 12, 17.5, 22.5].forEach(x => g.fillRect(x, 13, 2.4, 10)); g.fillRect(5, 24, 21, 2.4);
    g.generateTexture('ic_bank', 30, 30);

    g.clear(); g.lineStyle(2.6, 0xffffff, 1);
    g.beginPath(); g.moveTo(8, 11); g.lineTo(22, 11); g.lineTo(24, 25); g.lineTo(6, 25); g.closePath(); g.strokePath();
    g.beginPath(); g.arc(15, 11, 4.5, Math.PI, 0, true); g.strokePath();                 // merchant bag handle
    g.generateTexture('ic_merchant', 30, 30);

    g.clear(); g.lineStyle(2.6, 0xffffff, 1); g.strokeRoundedRect(5, 5, 20, 20, 4);       // casino die
    g.fillStyle(0xffffff, 1);[[10, 10], [20, 10], [15, 15], [10, 20], [20, 20]].forEach(([x, y]) => g.fillCircle(x, y, 1.7));
    g.generateTexture('ic_casino', 30, 30);

    g.clear(); g.lineStyle(2.4, 0xffffff, 1);                                             // BBQ kebab skewer (was a fish)
    g.beginPath(); g.moveTo(4, 25); g.lineTo(27, 6); g.strokePath();                       // skewer stick
    g.fillStyle(0xffffff, 1);
    g.fillCircle(10, 20, 3.2); g.fillCircle(15.5, 15.5, 3.2); g.fillCircle(21, 11, 3.2);   // 3 meat chunks
    g.generateTexture('ic_cooking', 30, 30);

    // gold trophy (for the quest-complete gate) — pixel-art cup with handles + base
    g.clear();
    const trDk = 0x6b4a12, trGold = 0xffd24a, trGold2 = 0xe0a93c, trHi = 0xfff0b0;
    g.fillStyle(trDk, 1); g.fillRect(12, 41, 20, 4); g.fillRect(16, 37, 12, 4);            // base
    g.fillStyle(trGold2, 1); g.fillRect(14, 41, 16, 3); g.fillRect(20, 30, 4, 8);          // plinth + stem
    g.lineStyle(3, trDk, 1);                                                               // handles (outline)
    g.beginPath(); g.arc(11, 16, 6, Math.PI / 2, Math.PI * 1.5, false); g.strokePath();
    g.beginPath(); g.arc(33, 16, 6, -Math.PI / 2, Math.PI / 2, false); g.strokePath();
    g.fillStyle(trDk, 1);                                                                  // cup bowl outline
    g.beginPath(); g.moveTo(8, 7); g.lineTo(36, 7); g.lineTo(31, 29); g.lineTo(13, 29); g.closePath(); g.fillPath();
    g.fillStyle(trGold, 1);                                                                // cup gold
    g.beginPath(); g.moveTo(10, 9); g.lineTo(34, 9); g.lineTo(29.5, 27); g.lineTo(14.5, 27); g.closePath(); g.fillPath();
    g.fillStyle(trGold2, 1); g.fillRect(8, 7, 28, 3);                                      // rim
    g.fillStyle(trHi, 1); g.fillRect(13, 12, 3, 13);                                       // highlight
    g.generateTexture('ic_trophy', 44, 46);

    // coin pouch (wallet) — for the "Connect Wallet" button
    g.clear();
    const pDk = 0x2a1c0c, pBr = 0x6b4a26, pBr2 = 0x533819, pGold = 0xffd24a;
    g.fillStyle(pDk, 1); g.fillRoundedRect(4, 11, 28, 24, 8);
    g.fillStyle(pBr, 1); g.fillRoundedRect(5, 12, 26, 22, 7);
    g.fillStyle(pBr2, 1); g.fillRoundedRect(5, 24, 26, 10, 7);                             // lower shade
    g.fillStyle(pBr2, 1); g.fillRect(12, 6, 12, 7);                                        // drawstring neck
    g.fillStyle(pGold, 1); g.fillRect(11, 10, 14, 2.5);                                    // gold tie
    g.fillStyle(pGold, 1); g.fillCircle(18, 24, 5); g.fillStyle(pBr2, 1); g.fillRect(16.6, 23, 3, 2.4);   // coin
    g.generateTexture('ic_pouch', 36, 38);

    // reward ribbon/banner (red cloth, gold trim, forked ends) — behind the gate title
    g.clear();
    const bnDk = 0x6e1f1f, bnRed = 0xb23b3b, bnRed2 = 0x8e2a2a, bnGold = 0xffd24a, bnHi = 0xd05656;
    g.fillStyle(bnDk, 1);
    g.fillPoints([{ x: 0, y: 7 }, { x: 160, y: 7 }, { x: 148, y: 24 }, { x: 160, y: 41 }, { x: 0, y: 41 }, { x: 12, y: 24 }], true);
    g.fillStyle(bnRed, 1);
    g.fillPoints([{ x: 4, y: 10 }, { x: 156, y: 10 }, { x: 145, y: 24 }, { x: 156, y: 38 }, { x: 4, y: 38 }, { x: 15, y: 24 }], true);
    g.fillStyle(bnRed2, 1); g.fillRect(6, 25, 150, 13);                                    // lower shade
    g.fillStyle(bnHi, 1); g.fillRect(6, 13, 150, 3);                                       // top highlight
    g.fillStyle(bnGold, 1); g.fillRect(4, 10, 152, 2.5); g.fillRect(4, 35.5, 152, 2.5);    // gold trim
    g.generateTexture('ic_banner', 160, 48);

    // settings gear (hollow centre so it reads on any bg)
    g.clear(); g.lineStyle(3, 0xffffff, 1); g.strokeCircle(13, 13, 6.5);
    g.fillStyle(0xffffff, 1);
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.fillRect(13 + Math.cos(a) * 11 - 2, 13 + Math.sin(a) * 11 - 2, 4, 4); }
    g.fillCircle(13, 13, 2.4);
    g.generateTexture('ic_gear', 26, 26);

    // music note
    g.clear(); g.fillStyle(0xffffff, 1);
    g.fillEllipse(9, 19, 9, 6.5); g.fillRect(12.2, 5, 2.4, 14); g.fillTriangle(13, 5, 21, 8, 13, 11.5);
    g.generateTexture('ic_music', 26, 26);

    // speaker with sound waves
    g.clear(); g.fillStyle(0xffffff, 1);
    g.fillRect(3, 10, 4, 6); g.fillTriangle(7, 7, 7, 19, 13, 13);
    g.lineStyle(2, 0xffffff, 1);
    g.beginPath(); g.arc(14, 13, 4, -0.6, 0.6, false); g.strokePath();
    g.beginPath(); g.arc(14, 13, 7.5, -0.7, 0.7, false); g.strokePath();
    g.generateTexture('ic_sound', 26, 26);

    // keyboard (keybinds)
    g.clear(); g.lineStyle(2, 0xffffff, 1); g.strokeRoundedRect(2, 7, 22, 12, 3);
    g.fillStyle(0xffffff, 1);
    [[6, 11], [10, 11], [14, 11], [18, 11], [6, 15], [10, 15]].forEach(([x, y]) => g.fillRect(x - 1, y - 1, 2, 2));
    g.fillRect(13, 14.5, 7, 2);                                                            // spacebar
    g.generateTexture('ic_keys', 26, 26);

    // skull (danger-zone marker on the maps)
    g.clear(); g.fillStyle(0xffffff, 1);
    g.fillCircle(13, 11, 8); g.fillRoundedRect(8, 15, 10, 7, 2);                            // cranium + jaw
    g.fillStyle(0x141826, 1);
    g.fillCircle(10, 11, 2.6); g.fillCircle(16, 11, 2.6);                                   // eye sockets
    g.fillTriangle(13, 12.5, 11.6, 16, 14.4, 16);                                           // nose
    g.fillRect(10, 19, 1.3, 3); g.fillRect(12.4, 19, 1.3, 3); g.fillRect(14.8, 19, 1.3, 3); // teeth gaps
    g.generateTexture('ic_skull', 26, 26);

    // tree stump (half-cut tree) — bark sides + ringed cut top
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(18, 33, 30, 8);
    g.fillStyle(0x5a3a1e, 1); g.fillRoundedRect(6, 14, 24, 18, 4);            // bark column
    g.fillStyle(0x6b4423, 1); g.fillRoundedRect(8, 14, 20, 16, 3);
    g.fillStyle(0x4a2f18, 1); g.fillRect(6, 27, 24, 5);                       // base shade
    g.fillStyle(0xc8945a, 1); g.fillEllipse(18, 14, 24, 11);                 // cut top
    g.lineStyle(1.6, 0x8a5a2e, 1); g.strokeEllipse(18, 14, 17, 7.5); g.strokeEllipse(18, 14, 10, 4.5);
    g.fillStyle(0x8a5a2e, 1); g.fillCircle(18, 14, 1.6);
    g.generateTexture('stump', 36, 36);

    // single fallen log
    const oneLog = (key, w, h) => {
      g.clear();
      g.fillStyle(0x000000, 0.18); g.fillEllipse(w / 2, h - 3, w - 6, 6);
      g.fillStyle(0x5a3a1e, 1); g.fillRoundedRect(2, h - 16, w - 4, 12, 6);
      g.fillStyle(0x7a4e28, 1); g.fillRoundedRect(3, h - 15, w - 6, 10, 5);
      g.fillStyle(0x916036, 1); g.fillRoundedRect(3, h - 15, w - 6, 4, 4);     // top highlight
      g.fillStyle(0xc8945a, 1); g.fillEllipse(7, h - 10, 8, 10);               // cut end
      g.lineStyle(1.2, 0x6b4423, 1); g.strokeEllipse(7, h - 10, 4.5, 6);
      g.generateTexture(key, w, h);
    };
    oneLog('log1', 40, 22);

    // stacked woodpile (horizontal logs stacked up)
    g.clear();
    g.fillStyle(0x000000, 0.24); g.fillEllipse(34, 36, 60, 10);
    const pileLog = (x, y, w) => {
      g.fillStyle(0x4a2f18, 1); g.fillRoundedRect(x, y, w, 12, 6);
      g.fillStyle(0x7a4e28, 1); g.fillRoundedRect(x + 1, y + 1, w - 2, 10, 5);
      g.fillStyle(0x916036, 1); g.fillRoundedRect(x + 1, y + 1, w - 2, 4, 4);
      g.fillStyle(0xc8945a, 1); g.fillEllipse(x + 6, y + 6, 9, 11);
      g.lineStyle(1.2, 0x6b4423, 1); g.strokeEllipse(x + 6, y + 6, 5, 6.5);
    };
    pileLog(4, 22, 56); pileLog(2, 12, 34); pileLog(38, 12, 24); pileLog(12, 3, 38);
    g.generateTexture('logstack', 68, 40);

    // ---- Fisher's Hut decor -------------------------------------------------
    // wooden barrel — vertical staves + dark metal hoops
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(18, 41, 28, 7);
    g.fillStyle(0x6b4a2a, 1); g.fillRoundedRect(5, 7, 26, 32, 6);                 // body
    g.fillStyle(0x7d5731, 1); g.fillRoundedRect(7, 8, 22, 30, 5);
    for (let i = 0; i < 4; i++) { g.fillStyle(0x5a3d22, 0.55); g.fillRect(10 + i * 5, 9, 1.5, 28); }  // staves
    g.fillStyle(0x3a3f4a, 1); g.fillRect(5, 12, 26, 3.5); g.fillRect(5, 30, 26, 3.5);                 // hoops
    g.fillStyle(0x565c69, 1); g.fillRect(5, 12, 26, 1.2); g.fillRect(5, 30, 26, 1.2);
    g.fillStyle(0x8a6038, 1); g.fillEllipse(18, 8, 24, 7);                        // top rim
    g.fillStyle(0x5a3d22, 1); g.fillEllipse(18, 8, 18, 5);
    g.generateTexture('barrel', 36, 46);

    // woven fish basket — wicker bowl with two fish tails poking out
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(22, 32, 36, 8);
    g.fillStyle(0xb0823f, 1); g.beginPath(); g.moveTo(5, 16); g.lineTo(39, 16); g.lineTo(34, 33); g.lineTo(10, 33); g.closePath(); g.fillPath();
    g.fillStyle(0xc79a55, 1); g.beginPath(); g.moveTo(7, 17); g.lineTo(37, 17); g.lineTo(33, 31); g.lineTo(11, 31); g.closePath(); g.fillPath();
    for (let i = 1; i < 5; i++) { g.fillStyle(0x8a6531, 0.5); g.fillRect(6 + i * 6, 17, 1.4, 14); }   // weave verticals
    g.fillStyle(0x8a6531, 0.5); g.fillRect(8, 22, 28, 1.4); g.fillRect(9, 27, 26, 1.4);               // weave horizontals
    g.fillStyle(0x9fb7c8, 1); g.fillEllipse(16, 14, 11, 7); g.fillTriangle(11, 14, 5, 10, 5, 18);      // fish 1
    g.fillStyle(0x8aa6ba, 1); g.fillEllipse(28, 13, 10, 6); g.fillTriangle(33, 13, 39, 9, 39, 17);     // fish 2
    g.fillStyle(0x21303b, 1); g.fillCircle(18, 13, 1.2); g.fillCircle(26, 12, 1.2);
    g.generateTexture('fishbasket', 44, 38);

    // dock crate — wooden box with a fish lying on top
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(20, 35, 32, 7);
    g.fillStyle(0x5e4327, 1); g.fillRoundedRect(5, 12, 30, 22, 3);
    g.fillStyle(0x77552f, 1); g.fillRoundedRect(7, 14, 26, 18, 2);
    g.lineStyle(2, 0x4a3420, 1); g.strokeRect(7, 14, 26, 18); g.beginPath(); g.moveTo(7, 14); g.lineTo(33, 32); g.moveTo(33, 14); g.lineTo(7, 32); g.strokePath();
    g.fillStyle(0x9fb7c8, 1); g.fillEllipse(20, 11, 22, 8); g.fillTriangle(31, 11, 39, 6, 39, 16);     // fish on top
    g.fillStyle(0x7e98ab, 1); g.fillEllipse(20, 12, 18, 5);
    g.fillStyle(0x21303b, 1); g.fillCircle(12, 10, 1.4);
    g.generateTexture('fishcrate', 42, 40);

    // ---- Miner's Cave decor -------------------------------------------------
    // big rocky cave mouth — grey mound with a dark arched opening + timber frame
    g.clear();
    g.fillStyle(0x000000, 0.26); g.fillEllipse(45, 76, 78, 12);
    g.fillStyle(0x4a4f59, 1); g.beginPath(); g.moveTo(4, 78); g.lineTo(14, 26); g.lineTo(45, 10); g.lineTo(76, 26); g.lineTo(86, 78); g.closePath(); g.fillPath();  // mound
    g.fillStyle(0x5b616c, 1); g.beginPath(); g.moveTo(14, 78); g.lineTo(22, 30); g.lineTo(45, 16); g.lineTo(60, 28); g.lineTo(72, 78); g.closePath(); g.fillPath();   // lit face
    g.fillStyle(0x6b7280, 1); g.fillTriangle(45, 16, 30, 34, 60, 34);                                  // top highlight
    g.fillStyle(0x0c0e14, 1); g.beginPath(); g.moveTo(28, 78); g.lineTo(30, 44); g.arc(45, 44, 15, Math.PI, 0, false); g.lineTo(62, 78); g.closePath(); g.fillPath();  // opening
    g.fillStyle(0x1b2030, 1); g.fillEllipse(45, 50, 20, 9);                                            // inner glow-ish lip
    g.fillStyle(0x3a2a18, 1); g.fillRect(24, 42, 6, 36); g.fillRect(60, 42, 6, 36); g.fillRect(22, 38, 46, 7);   // timber frame
    g.fillStyle(0x4a3620, 1); g.fillRect(25, 42, 2, 36); g.fillRect(61, 42, 2, 36);
    g.lineStyle(2, 0x383d47, 1); g.beginPath(); g.moveTo(20, 56); g.lineTo(34, 50); g.moveTo(58, 50); g.lineTo(74, 58); g.strokePath();  // cracks
    g.generateTexture('cavemouth', 90, 84);

    // grey boulder — rounded rock with highlight + cracks
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(22, 33, 38, 8);
    g.fillStyle(0x595f69, 1); g.fillEllipse(22, 20, 38, 28);
    g.fillStyle(0x6b727d, 1); g.fillEllipse(20, 16, 30, 20);
    g.fillStyle(0x7c838e, 1); g.fillEllipse(16, 12, 14, 9);                                            // top highlight
    g.lineStyle(1.6, 0x3f444d, 1); g.beginPath(); g.moveTo(10, 18); g.lineTo(20, 24); g.lineTo(16, 30); g.moveTo(30, 14); g.lineTo(28, 26); g.strokePath();
    g.generateTexture('boulder', 44, 38);

    // mine cart — metal tub on wheels, heaped with grey ore + a lump of coal
    g.clear();
    g.fillStyle(0x000000, 0.24); g.fillEllipse(24, 37, 42, 8);
    g.fillStyle(0x2c2f36, 1); g.fillCircle(12, 33, 6); g.fillCircle(36, 33, 6);                        // wheels
    g.fillStyle(0x52575f, 1); g.fillCircle(12, 33, 2.4); g.fillCircle(36, 33, 2.4);
    g.fillStyle(0x4a4036, 1); g.beginPath(); g.moveTo(4, 18); g.lineTo(44, 18); g.lineTo(39, 32); g.lineTo(9, 32); g.closePath(); g.fillPath();  // tub
    g.fillStyle(0x5d5046, 1); g.beginPath(); g.moveTo(7, 20); g.lineTo(41, 20); g.lineTo(37, 30); g.lineTo(11, 30); g.closePath(); g.fillPath();
    g.fillStyle(0x6b727d, 1); g.fillEllipse(16, 17, 13, 8); g.fillEllipse(30, 16, 12, 7);              // ore heap
    g.fillStyle(0x7c838e, 1); g.fillEllipse(14, 15, 7, 4);
    g.fillStyle(0x23262d, 1); g.fillEllipse(26, 17, 8, 5);                                             // coal lump
    g.generateTexture('minecart', 48, 42);

    // ---- Training Ground decor ----------------------------------------------
    // straw training dummy — crossbar post, burlap body, helmeted head
    g.clear();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(20, 51, 22, 6);
    g.fillStyle(0x6b4a2a, 1); g.fillRect(17, 16, 6, 35);                          // post
    g.fillStyle(0x5a3d22, 1); g.fillRect(8, 22, 24, 5);                           // crossbar arms
    g.fillStyle(0xcaa45e, 1); g.fillEllipse(20, 30, 24, 22);                      // burlap body
    g.fillStyle(0xb8924c, 1); g.fillEllipse(20, 30, 16, 16);
    g.lineStyle(2, 0x8a6531, 1); g.strokeEllipse(20, 30, 9, 9); g.strokeEllipse(20, 30, 4, 4);   // hit rings
    g.fillStyle(0xc7a05a, 1); g.fillEllipse(20, 13, 13, 12);                      // straw head
    g.fillStyle(0x6b727d, 1); g.beginPath(); g.arc(20, 13, 8, Math.PI, 0, true); g.closePath(); g.fillPath();  // metal helm
    g.fillStyle(0x52575f, 1); g.fillRect(12, 12, 16, 2.4);
    g.generateTexture('dummy', 40, 54);

    // straw archery target on a little stand
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(20, 37, 22, 6);
    g.fillStyle(0x5a3d22, 1); g.fillRect(11, 26, 4, 12); g.fillRect(25, 26, 4, 12);   // legs
    g.fillStyle(0xc7a05a, 1); g.fillCircle(20, 20, 18);                           // straw rim
    g.fillStyle(0xede3c4, 1); g.fillCircle(20, 20, 14);
    g.fillStyle(0xd24b4b, 1); g.fillCircle(20, 20, 11);                           // red/white rings
    g.fillStyle(0xede3c4, 1); g.fillCircle(20, 20, 7.5);
    g.fillStyle(0xd24b4b, 1); g.fillCircle(20, 20, 4);
    g.fillStyle(0xffd23b, 1); g.fillCircle(20, 20, 1.6);                          // bullseye
    g.generateTexture('target', 40, 42);

    // weapon rack — wooden frame holding a sword and a spear
    g.clear();
    g.fillStyle(0x000000, 0.2); g.fillEllipse(24, 41, 40, 7);
    g.fillStyle(0x6b4a2a, 1); g.fillRect(6, 10, 5, 30); g.fillRect(37, 10, 5, 30); g.fillRect(6, 11, 36, 5); g.fillRect(6, 30, 36, 4);  // frame
    g.fillStyle(0x5a3d22, 1); g.fillRect(6, 30, 36, 1.5);
    g.fillStyle(0xb9c2d0, 1); g.fillRect(15, 6, 3.2, 30);                         // sword blade
    g.fillStyle(0x394150, 1); g.fillRect(11, 33, 11, 3); g.fillRect(15, 35, 3.2, 5);   // sword guard + grip
    g.fillStyle(0x8a6531, 1); g.fillRect(29, 4, 2.6, 36);                         // spear shaft
    g.fillStyle(0xc7cedd, 1); g.fillTriangle(30.3, -2, 27, 8, 33.5, 8);          // spear head
    g.generateTexture('weaponrack', 48, 44);

    // guide arrow (points right at 0 rotation) — dark outline + gold fill
    g.clear();
    g.fillStyle(0x10142b, 1); g.fillRect(0, 5, 14, 9); g.fillTriangle(9, -1, 9, 21, 25, 10);
    g.fillStyle(0xffd23b, 1); g.fillRect(2, 7, 11, 5); g.fillTriangle(11, 2, 11, 18, 21, 10);
    g.generateTexture('guidearrow', 26, 22);

    // iso floor arrow, drawn flat on a 64x32 tile pointing up-right (the −gy
    // direction = toward the building). white so it can be tinted grey/green.
    g.clear();
    const aPts = [
      { x: 21.9, y: 24.9 }, { x: 36.3, y: 17.8 }, { x: 38.7, y: 22.8 }, { x: 47.2, y: 8.4 },
      { x: 30.7, y: 6.6 }, { x: 33.1, y: 11.6 }, { x: 18.8, y: 18.7 },
    ];
    g.fillStyle(0xffffff, 1); g.fillPoints(aPts, true);
    g.lineStyle(2, 0x0a1124, 1); g.strokePoints(aPts, true);
    g.generateTexture('tilearrow', 64, 32);

    // white iso-diamond, tile-sized — tinted green & faded in as a "you can enter here" highlight
    g.clear();
    g.fillStyle(0xffffff, 1); g.fillPoints([{ x: 32, y: 1 }, { x: 63, y: 16 }, { x: 32, y: 31 }, { x: 1, y: 16 }], true);
    g.generateTexture('tilehi', 64, 32);

    // ---- bank interior ----
    tile('bankfloor_a', 0xddcfa6);             // marble cream
    tile('bankfloor_b', 0xcdbd8d);
    // wall block (iso cube) — wood-panelled bank wall; base diamond centred 16px above the bottom
    g.clear();
    g.fillStyle(0x4a3622, 1); g.fillPoints([{ x: 0, y: 16 }, { x: 32, y: 32 }, { x: 32, y: 72 }, { x: 0, y: 56 }], true);   // left face
    g.fillStyle(0x5c4528, 1); g.fillPoints([{ x: 32, y: 32 }, { x: 64, y: 16 }, { x: 64, y: 56 }, { x: 32, y: 72 }], true);  // right face
    g.fillStyle(0x6e5230, 1); g.fillPoints([{ x: 32, y: 0 }, { x: 64, y: 16 }, { x: 32, y: 32 }, { x: 0, y: 16 }], true);    // top
    g.fillStyle(0x3c2c1a, 1); g.fillRect(0, 34, 64, 2);                                                                      // panel seam
    g.generateTexture('bankwall', 64, 72);
    // vault door (decor against the back wall): gold-trim frame, steel door, bolts + combo dial
    g.clear();
    g.fillStyle(0x7a5d28, 1); g.fillRoundedRect(0, 0, 58, 66, 9);                 // gold frame
    g.fillStyle(0xb08a3e, 1); g.fillRoundedRect(2, 2, 54, 62, 8);                 // gold inner trim
    g.fillStyle(0x474f5e, 1); g.fillRoundedRect(6, 6, 46, 54, 6);                 // steel door
    g.fillStyle(0x39414f, 1); g.fillRoundedRect(9, 9, 40, 48, 5);                 // door inset
    g.fillStyle(0x8b95a8, 1);                                                     // rivets around the edge
    for (const [bx, by] of [[13, 13], [45, 13], [13, 53], [45, 53], [29, 11], [29, 55]]) g.fillCircle(bx, by, 2);
    g.fillStyle(0x2a313c, 1); g.fillCircle(29, 33, 14);                           // dial recess
    g.lineStyle(3, 0xcdd6e6, 1); g.strokeCircle(29, 33, 14);                      // chrome ring
    g.lineStyle(2, 0x70798c, 1); g.strokeCircle(29, 33, 9);
    g.fillStyle(0xcdd6e6, 1); g.fillCircle(29, 33, 3.5);                          // hub
    g.fillStyle(0xffd76b, 1); g.fillCircle(29, 21, 2.5);                          // gold dial pointer at 12 o'clock
    g.fillStyle(0xffd76b, 1); g.fillRoundedRect(50, 30, 6, 8, 2);                 // gold handle
    g.generateTexture('vaultdoor', 58, 66);

    // roulette table: green felt oval + wheel with alternating red/black pockets
    g.clear();
    g.fillStyle(0x000000, 0.18); g.fillEllipse(40, 52, 70, 12);                   // floor shadow
    g.fillStyle(0x5a3a22, 1); g.fillEllipse(40, 40, 74, 30);                      // wood rim
    g.fillStyle(0x1f7a45, 1); g.fillEllipse(40, 38, 62, 24);                      // green felt
    g.fillStyle(0xc9a23a, 1); g.fillCircle(40, 33, 16);                           // gold wheel rim
    g.fillStyle(0x20242e, 1); g.fillCircle(40, 33, 13);
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; g.fillStyle(i % 2 ? 0xb23b3b : 0x10131a, 1); g.fillCircle(40 + Math.cos(a) * 10, 33 + Math.sin(a) * 9, 2.2); }
    g.fillStyle(0xcdd6e6, 1); g.fillCircle(40, 33, 3.5);                          // spinner hub
    g.generateTexture('roulette_table', 80, 58);

    // blackjack table: green felt, gold arc, three white bet circles
    g.clear();
    g.fillStyle(0x000000, 0.18); g.fillEllipse(40, 50, 66, 11);
    g.fillStyle(0x5a3a22, 1); g.fillEllipse(40, 36, 74, 30);                      // wood rim
    g.fillStyle(0x1f7a45, 1); g.fillEllipse(40, 34, 64, 24);                      // green felt
    g.lineStyle(2, 0xe8d27a, 1); g.beginPath(); g.arc(40, 30, 24, 0.18 * Math.PI, 0.82 * Math.PI, false); g.strokePath();   // gold dealer arc
    g.lineStyle(2, 0xeef1f7, 0.9); for (const cx of [24, 40, 56]) g.strokeCircle(cx, 40, 5);   // bet spots
    g.generateTexture('blackjack_table', 80, 54);

    g.destroy();
  }

  // dirt roads from the central plaza out to every POI (never to the danger zone)
  computePaths(cfg) {
    const set = new Set();
    if (cfg.biome !== 'grass' || !cfg.plaza) return set;
    const add = (x, y) => { if (x >= 0 && y >= 0 && x < GRID && y < GRID) set.add(x + ',' + y); };
    const lpath = (ax, ay, bx, by) => {                 // 2-wide L-shaped road
      let x = ax, y = ay;
      while (x !== bx) { add(x, y); add(x, y + 1); x += Math.sign(bx - x); }
      while (y !== by) { add(x, y); add(x + 1, y); y += Math.sign(by - y); }
      add(x, y); add(x + 1, y); add(x, y + 1);
    };
    const hub = [Math.round(cfg.plaza.cx), Math.round(cfg.plaza.cy)];
    const dests = [];
    if (cfg.arena) dests.push([cfg.arena.cx, cfg.arena.cy]);
    for (const s of (cfg.structures || [])) if (s.type === 'forge' || s.type === 'house') dests.push([s.x, s.y]);
    for (const b of (cfg.buildings || [])) if (b.key !== 'traincamp') dests.push([b.gx, b.gy]);  // no road through the training clearing
    for (const d of dests) lpath(hub[0], hub[1], Math.round(d[0]), Math.round(d[1]));
    return set;
  }

  buildGround(cfg) {
    this.tiles = []; this.tileIndex = {}; this.waterTiles = [];
    if (cfg.interior) return this.buildInteriorGround(cfg);
    this.pathTiles = this.computePaths(cfg);
    const tk = BIOMES[cfg.biome], isW = cfg.water;
    for (let gx = 0; gx < GRID; gx++) {
      for (let gy = 0; gy < GRID; gy++) {
        const water = isW(gx, gy);
        const sand = !water && (isW(gx + 1, gy) || isW(gx - 1, gy) || isW(gx, gy + 1) || isW(gx, gy - 1) ||
          isW(gx + 1, gy + 1) || isW(gx - 1, gy - 1) || isW(gx + 1, gy - 1) || isW(gx - 1, gy + 1));
        const arena = cfg.arena && Math.hypot(gx - cfg.arena.cx, gy - cfg.arena.cy) <= cfg.arena.r;
        const plaza = cfg.plaza && Math.hypot(gx - cfg.plaza.cx, gy - cfg.plaza.cy) <= cfg.plaza.r;
        const key = water ? tk.water : arena ? 'arena' : sand ? tk.sand : ((gx + gy) % 2 ? tk.a : tk.b);
        const px = this.worldOX + isoX(gx, gy), py = this.worldOY + isoY(gx, gy);
        // real CC0 tiles scaled to our 64x32 grid; water stays generated (no full water frame in the set)
        const ds = (sheet, frame) => this.add.image(px, py, sheet, frame).setDisplaySize(TILE_W, TILE_H);
        let t;
        if (water) {
          t = this.add.image(px, py, 'water_lit').setDisplaySize(TILE_W + 1, TILE_H + 1);
          const murky = 0x9fb6c4;                                // lighter blue-grey for the wilderness
          if (cfg.biome === 'wild') t.setTint(murky);
          t.baseTint = (cfg.biome === 'wild') ? murky : 0xffffff;
        }
        else if (arena) t = this.add.image(px, py, 'arena');     // ring mat
        else if (plaza) t = this.add.image(px, py, 'plaza');     // cobblestone healing plaza
        else if (sand) t = ds('sand_sheet', 0);
        else if (this.pathTiles.has(gx + ',' + gy)) t = ds('dirt_sheet', (gx + gy) % 2 ? 0 : 2);   // dirt road
        else if (cfg.biome === 'grass') t = ds('grass_sheet', (gx + gy) % 2 ? 0 : 8);
        else if (cfg.biome === 'wild') t = ds('dirt_sheet', (gx + gy) % 2 ? 0 : 2);
        else t = this.add.image(px, py, key);
        t.setDepth(-10000 + isoDepth(gx, gy));
        t.gx = gx; t.gy = gy; t.water = water; t.sand = sand;
        this.tiles.push(t);
        this.tileIndex[gx + ',' + gy] = t;
        if (water) this.waterTiles.push(t);
      }
    }
  }

  // small indoor room: marble floor inside the rect, everything else blocked
  buildInteriorGround(cfg) {
    const r = cfg.room;
    for (let gx = 0; gx < GRID; gx++) {
      for (let gy = 0; gy < GRID; gy++) {
        const inRoom = gx >= r.x0 && gx <= r.x1 && gy >= r.y0 && gy <= r.y1;
        if (!inRoom) { this.markOccupied(gx, gy); continue; }       // void outside the room = unwalkable
        const px = this.worldOX + isoX(gx, gy), py = this.worldOY + isoY(gx, gy);
        const t = this.add.image(px, py, (gx + gy) % 2 ? 'bankfloor_a' : 'bankfloor_b').setDisplaySize(TILE_W, TILE_H);
        t.setDepth(-10000 + isoDepth(gx, gy));
        t.gx = gx; t.gy = gy; t.water = false; t.sand = false;
        this.tiles.push(t); this.tileIndex[gx + ',' + gy] = t;
      }
    }
  }

  // wall cube standing on the back edge of the room (blocks the tile, draws behind)
  addWall(gx, gy) {
    const wx = this.worldOX + isoX(gx, gy), wy = this.worldOY + isoY(gx, gy);
    const w = this.add.image(wx, wy + 16, 'bankwall').setOrigin(0.5, 1).setDepth(isoDepth(gx, gy) + 0.4);
    this.structures.push({ type: 'decor', sprite: w, label: null });
    this.markOccupied(gx, gy);
  }

  // furniture/decor that blocks its tile; optionally clickable to open a panel
  addProp(p) {
    const wx = this.worldOX + isoX(p.gx, p.gy), wy = this.worldOY + isoY(p.gx, p.gy);
    const s = this.add.image(wx, wy + (p.oy || 0), p.tex).setOrigin(0.5, p.anchor || 0.82).setDepth(isoDepth(p.gx, p.gy) + 0.5);
    if (p.scale) s.setScale(p.scale);
    if (p.opens) {
      s.setInteractive({ useHandCursor: true });
      s.on('pointerdown', (pt, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.openByKey(p.opens); });
    }
    this.structures.push({ type: 'decor', sprite: s, label: null });
    this.markOccupied(p.gx, p.gy);
  }

  // a standing NPC dealer (axul sprite), tinted for the "all black" dress code
  addDealer(d) {
    const wx = this.worldOX + isoX(d.gx, d.gy), wy = this.worldOY + isoY(d.gx, d.gy);
    const npc = d.npc || 'red';
    const s = this.add.sprite(wx, wy + 6, 'axul', AXUL_ROW[npc] * AXUL_COLS + AXUL_DIR_S)
      .setOrigin(0.5, 0.92).setScale(2.3).setDepth(isoDepth(d.gx, d.gy) + 0.6).play(npc + '_idle_' + AXUL_DIR_S);
    if (d.tint) s.setTint(d.tint);
    this.structures.push({ type: 'decor', sprite: s, label: null });
    this.markOccupied(d.gx, d.gy);
  }

  buildInteriorDecor(cfg) {
    const r = cfg.room;
    for (let gx = r.x0 - 1; gx <= r.x1; gx++) this.addWall(gx, r.y0 - 1);          // back-right wall (north edge)
    for (let gy = r.y0; gy <= r.y1; gy++) this.addWall(r.x0 - 1, gy);              // back-left wall (west edge)
    if (cfg.vault) {                                                              // vault door centred on the back wall
      const vx = Math.round((r.x0 + r.x1) / 2), vy = r.y0 - 1;
      const vwx = this.worldOX + isoX(vx, vy), vwy = this.worldOY + isoY(vx, vy);
      const vault = this.add.image(vwx, vwy - 6, 'vaultdoor').setOrigin(0.5, 1).setDepth(isoDepth(vx, vy) + 0.45);
      this.structures.push({ type: 'decor', sprite: vault, label: null });
    }
    for (const p of (cfg.props || [])) this.addProp(p);
    for (const d of (cfg.dealers || [])) this.addDealer(d);
    // exit arrow: step on it to leave (green-highlighted portal back to the world)
    const e = cfg.exit;
    const ex = this.worldOX + isoX(e.gx, e.gy), ey = this.worldOY + isoY(e.gx, e.gy);
    const dep = isoDepth(e.gx, e.gy);
    const hi = this.add.image(ex, ey, 'tilehi').setOrigin(0.5).setTint(0x66ff7a).setAlpha(0).setDepth(dep + 0.1);
    const arrow = this.add.image(ex, ey, 'tilearrow').setOrigin(0.5).setAngle(180).setDepth(dep + 0.2);   // point outward
    const bp = { b: null, to: e.to, spawn: e.spawn, gx: e.gx, gy: e.gy, sprite: arrow, hi, armed: true, t: 0 };
    arrow.setInteractive({ useHandCursor: true });
    arrow.on('pointerdown', (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.onEntryArrowClick(bp); });
    this.structures.push({ type: 'portalarrow', sprite: arrow, label: hi });
    this.buildingPortals.push(bp);
  }

  isWater(gx, gy) { const t = this.tileIndex[gx + ',' + gy]; return t ? t.water : false; }
  inBounds(gx, gy) { return gx >= 0 && gy >= 0 && gx < GRID && gy < GRID; }
  markOccupied(gx, gy) { this.occupied.add(gx + ',' + gy); }
  // block a building footprint (collision) + a 1-tile clearance ring where resources can't spawn
  reserve(gx, gy, w, h) {
    for (let dx = -1; dx <= w; dx++) for (let dy = -1; dy <= h; dy++) {
      this.noSpawn.add((gx + dx) + ',' + (gy + dy));
      if (dx >= 0 && dx < w && dy >= 0 && dy < h) this.markOccupied(gx + dx, gy + dy);
    }
  }
  unmarkOccupied(gx, gy) { this.occupied.delete(gx + ',' + gy); }

  // a tile you can stand on
  isWalkable(gx, gy) {
    if (!this.inBounds(gx, gy)) return false;
    if (this.isWater(gx, gy)) return false;
    if (this.occupied.has(gx + ',' + gy)) return false;
    return true;
  }

  // ---- A* pathfinding -------------------------------------------------------
  findPath(sx, sy, tx, ty) {
    sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
    if (!this.isWalkable(tx, ty)) return null;
    if (sx === tx && sy === ty) return [];
    const key = (x, y) => x + ',' + y;
    const h = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);
    const open = new Map(), closed = new Set();
    const start = { x: sx, y: sy, g: 0, f: h(sx, sy), parent: null };
    open.set(key(sx, sy), start);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    while (open.size) {
      let cur = null;
      for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
      if (cur.x === tx && cur.y === ty) {
        const path = []; let n = cur;
        while (n) { path.push({ x: n.x, y: n.y }); n = n.parent; }
        path.reverse(); path.shift();              // drop the starting tile
        return path;
      }
      open.delete(key(cur.x, cur.y)); closed.add(key(cur.x, cur.y));
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (closed.has(key(nx, ny)) || !this.isWalkable(nx, ny)) continue;
        if (dx && dy && (!this.isWalkable(cur.x + dx, cur.y) || !this.isWalkable(cur.x, cur.y + dy))) continue; // no corner cut
        const g = cur.g + (dx && dy ? 1.414 : 1);
        const ex = open.get(key(nx, ny));
        if (ex && g >= ex.g) continue;
        const node = ex || { x: nx, y: ny };
        node.g = g; node.f = g + h(nx, ny); node.parent = cur;
        open.set(key(nx, ny), node);
      }
    }
    return null;
  }

  // nearest walkable tile adjacent to a node (so we can stand next to it)
  adjacentStand(node, fromGx, fromGy) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let best = null, bestD = Infinity;
    for (const [dx, dy] of dirs) {
      const x = node.gx + dx, y = node.gy + dy;
      if (!this.isWalkable(x, y)) continue;
      const d = Math.hypot(x - fromGx, y - fromGy);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
  }

  // a soft shadow shaped like the building's tile footprint diamond (grounds it on its tiles)
  footprintShadow(gx, gy, fw, fh, depth) {
    const g = this.add.graphics().setDepth(depth);
    const corners = [[gx - 0.5, gy - 0.5], [gx + fw - 0.5, gy - 0.5], [gx + fw - 0.5, gy + fh - 0.5], [gx - 0.5, gy + fh - 0.5]];
    g.fillStyle(0x000000, 0.16);
    g.beginPath();
    corners.forEach(([cx, cy], i) => {
      const x = this.worldOX + isoX(cx, cy), y = this.worldOY + isoY(cx, cy);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.closePath(); g.fillPath();
    return g;
  }

  // ---- structures (forge, houses, fountain, roast pit, tombstones, portals) --
  placeStructures(cfg) {
    this.structures = []; this.portals = []; this.portalTiles = new Set(); this.forge = null; this.fountainPos = null;
    for (const s of cfg.structures) {
      if (s.type === 'sign') { this.placeSign(s); continue; }
      const info = STRUCT_INFO[s.type] || { fw: 1, fh: 1, anchorY: 0.85, lift: 4 };
      const cx = s.x + (info.fw - 1) / 2, cy = s.y + (info.fh - 1) / 2;     // footprint centre
      const wx = this.worldOX + isoX(cx, cy), wy = this.worldOY + isoY(cx, cy);
      // deterministic per-position variant so a house keeps its colour across realm visits
      const texKey = s.type === 'house' ? HOUSE_TEX[(s.x * 7 + s.y * 5) % HOUSE_TEX.length] : STRUCT_TEX[s.type];
      const sprite = this.add.image(wx, wy + info.lift, texKey).setOrigin(0.5, info.anchorY)
        .setDepth(isoDepth(s.x + info.fw - 1, s.y + info.fh - 1) + 0.6);   // sort by front tile
      if (s.type === 'house') sprite.setScale(140 / sprite.width);        // iso house -> ~2x2 footprint
      else if (s.type === 'fountain') {
        sprite.setScale(2.0);                                             // pixel fountain -> 3x3 plaza
        const fy = wy - 16;                                              // animated water surface
        const shimmer = this.add.ellipse(wx, fy, 34, 15, 0x9bd8f7, 0.5).setDepth(sprite.depth + 0.1);
        this.tweens.add({ targets: shimmer, scaleX: { from: 0.82, to: 1.12 }, alpha: { from: 0.35, to: 0.65 },
          duration: 950, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
        this.structures.push({ type: 'fx', sprite: shimmer, label: null });
        this.fountainPos = { x: wx, y: fy };
      }
      const st = { type: s.type, gx: cx, gy: cy, sprite, label: null };
      if (s.type === 'forge') {
        st.label = this.structLabel('FORGE', cx, cy - 0.6, '#ffd07a');
        this.forge = { gx: cx, gy: cy, sprite, label: st.label };
      } else if (s.type === 'bonfire') {
        st.label = this.structLabel('BONFIRE', cx, cy - 0.6, '#ffb86b');
      }
      // houses occupy a slightly bigger footprint than their base so you can't walk into them
      if (s.type === 'house') this.reserve(s.x, s.y, info.fw + 1, info.fh + 1);
      else this.reserve(s.x, s.y, info.fw, info.fh);
      this.structures.push(st);
    }
    this.placeArenaRing(cfg);
  }

  // a fenced ring around the small PvP arena
  // soft pulsing healing aura over the central plaza
  createHealAura(cfg) {
    this.healAura = null;
    if (!cfg.plaza) return;
    const wx = this.worldOX + isoX(cfg.plaza.cx, cfg.plaza.cy), wy = this.worldOY + isoY(cfg.plaza.cx, cfg.plaza.cy);
    const g = this.add.graphics().setDepth(-9000);
    g.fillStyle(0x6dffb0, 0.12); g.fillEllipse(wx, wy, cfg.plaza.r * TILE_W * 1.7, cfg.plaza.r * TILE_H * 1.7);
    g.fillStyle(0x6dffb0, 0.10); g.fillEllipse(wx, wy, cfg.plaza.r * TILE_W, cfg.plaza.r * TILE_H);
    this.healAura = g;
    this.tweens.add({ targets: g, alpha: { from: 0.55, to: 1 }, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }

  // WWE-style ring: 4 corner posts + 3 ropes per side around the mat
  placeArenaRing(cfg) {
    if (!cfg.arena) return;
    const { cx, cy, r } = cfg.arena;
    const corners = [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
    const pw = corners.map(([gx, gy]) => {
      const wx = this.worldOX + isoX(gx, gy), wy = this.worldOY + isoY(gx, gy);
      const sprite = this.add.image(wx, wy + 4, 'ringpost').setOrigin(0.5, 0.92).setDepth(isoDepth(gx, gy) + 0.7);
      this.structures.push({ type: 'post', gx, gy, sprite, label: null });
      return { wx, wy };
    });
    const g = this.add.graphics().setDepth(8000); this.arenaRopes = g;
    const side = (a, b) => { for (const oy of [-46, -36, -26]) { g.lineStyle(2.5, 0xececf2, 0.95); g.lineBetween(a.wx, a.wy + oy, b.wx, b.wy + oy); } };
    side(pw[0], pw[1]); side(pw[1], pw[2]); side(pw[2], pw[3]); side(pw[3], pw[0]);
  }

  structLabel(text, gx, gy, color) {
    return this.add.text(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy) - 34, text, {
      fontSize: '14px', color, fontStyle: 'bold', stroke: '#10142b', strokeThickness: 4,
    }).setOrigin(0.5).setResolution(2).setDepth(99999);
  }

  placeSign(s) {
    const span = s.to ? (s.span || 1) : 1;
    const cx = s.x + (span - 1) / 2;                  // centre the billboard over the gate strip
    const wide = span > 1;
    const wx = this.worldOX + isoX(cx, s.y), wy = this.worldOY + isoY(cx, s.y);
    const sprite = this.add.image(wx, wy + 8, s.danger ? 'sign_danger' : 'sign').setOrigin(0.5, 0.85)
      .setDepth(isoDepth(s.x + span - 1, s.y) + 0.6);
    if (s.flip) sprite.setFlipX(true);
    if (wide) sprite.setScale(1.5);
    const label = this.add.text(wx, wy - (wide ? 92 : 64), s.text, {
      fontSize: wide ? '24px' : '18px', color: s.color || '#ffffff', fontStyle: 'bold',
      stroke: '#10142b', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(99999);
    this.structures.push({ type: 'sign', gx: s.x, gy: s.y, sprite, label });
    if (s.to) {                                       // wide walkable travel strip (span x 2 tiles)
      for (let i = 0; i < span; i++) for (let dy = 0; dy < 2; dy++) {
        const gx = s.x + i, gy = s.y + dy;
        this.portalTiles.add(gx + ',' + gy);
        this.portals.push({ gx, gy, to: s.to, danger: !!s.danger });
      }
    } else {
      this.markOccupied(s.x, s.y);
    }
  }

  // ---- resources ------------------------------------------------------------
  spawnResources(cfg) {
    const r = cfg.resources || {};
    let trees = r.tree || 0, rocks = r.rock || 0, coal = r.coal || 0, guard = 0;
    while (trees + rocks + coal > 0 && guard++ < 8000) {
      const kind = trees > 0 ? 'tree' : (rocks > 0 ? 'rock' : 'coal');
      // trees cluster into the forest, rocks/coal into the rocky cave ground; the rest scatter
      const area = kind === 'tree' ? cfg.treeArea : cfg.rockArea;
      let gx, gy;
      if (area && Math.random() < 0.6) { const p = this.sampleArea(area); gx = p.x; gy = p.y; }
      else { gx = Phaser.Math.Between(1, GRID - 2); gy = Phaser.Math.Between(1, GRID - 2); }
      if (!this.canSpawnAt(gx, gy)) continue;
      if (kind === 'tree') trees--; else if (kind === 'rock') rocks--; else coal--;
      this.placeResource(gx, gy, kind);
    }
  }

  sampleArea(a) {
    const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * a.r;
    return { x: Math.round(a.cx + Math.cos(ang) * rr), y: Math.round(a.cy + Math.sin(ang) * rr) };
  }

  // scatter the 3 building variants across the wilderness (10–20), at fixed seeded
  // spots so they never move between visits. Tracked in this.structures for cleanup.
  scatterSheds(cfg) {
    if (!cfg.sheds) return;
    const rng = new Phaser.Math.RandomDataGenerator([this.realm + '-buildings']);
    const variants = ['house1', 'house2', 'house3'];
    const n = rng.between(10, 20);
    let placed = 0, guard = 0;
    while (placed < n && guard++ < 4000) {
      const gx = rng.between(1, GRID - 2), gy = rng.between(1, GRID - 2);
      const tex = rng.pick(variants);
      // need a clear, dry 2x2 with a 1-tile margin (so sheds never sit in/over the pond)
      let ok = true;
      for (let dx = -1; dx <= 2 && ok; dx++) for (let dy = -1; dy <= 2; dy++)
        if (!this.inBounds(gx + dx, gy + dy) || this.isWater(gx + dx, gy + dy)) { ok = false; break; }
      if (!ok || !this.canSpawnAt(gx, gy) || !this.canSpawnAt(gx + 1, gy)) continue;
      const sprite = this.add.image(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy), tex)
        .setOrigin(0.5, 0.9).setDepth(isoDepth(gx + 1, gy + 1) + 0.6);
      sprite.setScale(150 / sprite.width);
      this.reserve(gx, gy, 2, 2);
      this.structures.push({ type: 'shed', sprite, label: null });
      placed++;
    }
  }

  // scattered non-blocking foliage decor (mushrooms, bushes) at fixed seeded spots
  scatterDecor(cfg) {
    const mode = cfg.decor ? 'all' : cfg.decorEdges ? 'edges' : null;
    if (!mode) return;
    const rng = new Phaser.Math.RandomDataGenerator([this.realm + '-decor']);
    const kinds = ['mushroom', 'bush', 'bush2'];
    const cx = cfg.plaza ? cfg.plaza.cx : GRID / 2, cy = cfg.plaza ? cfg.plaza.cy : GRID / 2;
    const n = rng.between(mode === 'edges' ? 26 : 20, mode === 'edges' ? 40 : 32);
    let placed = 0, guard = 0;
    while (placed < n && guard++ < 5000) {
      const gx = rng.between(1, GRID - 2), gy = rng.between(1, GRID - 2), k = rng.pick(kinds);
      if (!this.canSpawnAt(gx, gy)) continue;
      if (this.pathTiles && this.pathTiles.has(gx + ',' + gy)) continue;          // keep roads clear
      if (mode === 'edges' && Math.hypot(gx - cx, gy - cy) < 14) continue;        // keep the village core clear
      const s = this.add.image(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy) + 6, 'dec_' + k)
        .setOrigin(0.5, 0.85).setScale(1.5).setDepth(isoDepth(gx, gy) + 0.4);
      this.structures.push({ type: 'decor', sprite: s, label: null });
      placed++;
    }
  }

  // decorative dead/bare trees (e.g. flanking the danger-zone gate) — scenery, not choppable
  placeDeadTrees(cfg) {
    for (const [gx, gy] of (cfg.deadTrees || [])) {
      if (!this.inBounds(gx, gy)) continue;
      const sprite = this.add.image(
        this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy) + 6,
        'tree_b' + Phaser.Math.Between(0, 3)
      ).setOrigin(0.5, 0.9);
      sprite.setScale(92 / sprite.height).setDepth(isoDepth(gx, gy) + 0.5);
      this.markOccupied(gx, gy);
      this.structures.push({ type: 'deadtree', sprite, label: null });
    }
  }

  // walkable, not on a portal tile, and clear of the PvP ring & fountain plaza
  canSpawnAt(gx, gy) {
    if (!this.isWalkable(gx, gy)) return false;
    const t = this.tileIndex[gx + ',' + gy];
    if (t && t.sand) return false;                                       // keep the pond shore/border clear
    if (this.noSpawn && this.noSpawn.has(gx + ',' + gy)) return false;   // building clearance
    if (this.pathTiles && this.pathTiles.has(gx + ',' + gy)) return false;   // keep roads clear
    if (this.portalTiles && this.portalTiles.has(gx + ',' + gy)) return false;
    const cfg = this.realmCfg;
    if (cfg.arena && Math.hypot(gx - cfg.arena.cx, gy - cfg.arena.cy) <= cfg.arena.r + 0.6) return false;
    if (cfg.plaza && Math.hypot(gx - cfg.plaza.cx, gy - cfg.plaza.cy) <= cfg.plaza.r + 0.6) return false;
    return true;
  }

  placeResource(gx, gy, kind) {
    const def = NODES[kind];
    let texKey = def.tex, originY = 0.85;
    if (kind === 'tree') {                          // random real tree variant (dead trees in the wilderness)
      const bare = this.realmCfg && this.realmCfg.biome === 'wild';
      texKey = (bare ? 'tree_b' : 'tree_g') + Phaser.Math.Between(0, bare ? 3 : 5);
      originY = 0.9;
    }
    const sprite = this.add.image(
      this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy) + 6, texKey
    ).setOrigin(0.5, originY);
    // vary size + facing so nodes don't look identical
    const v = Phaser.Math.FloatBetween(0.72, 1.2);
    if (kind === 'tree') sprite.setScale(92 * Phaser.Math.FloatBetween(0.85, 1.15) / sprite.height);
    else sprite.setScale(34 * v / sprite.height);               // rock/coal cartoon boulders, varied
    sprite.setFlipX(Math.random() < 0.5);
    sprite.setDepth(isoDepth(gx, gy) + 0.5);
    sprite.setInteractive({ useHandCursor: true });
    const node = { gx, gy, kind, amount: def.max, sprite };
    sprite.on('pointerdown', (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.onResourceClick(node); });
    this.markOccupied(gx, gy);          // trees/rocks/coal block movement
    this.resources.push(node);
    return node;
  }

  depleteRespawn(node) {
    if (node._gone) return;                         // already felled/broken (e.g. two NPCs on one tree) — avoid double-destroy
    node._gone = true;
    const def = NODES[node.kind], token = this.realmToken;
    this.unmarkOccupied(node.gx, node.gy);          // free the tile immediately
    this.resources = this.resources.filter(r => r !== node);
    node.sprite.disableInteractive();
    if (node.kind === 'tree') this.playTreeFall(node);
    else this.playRockBreak(node);
    this.time.delayedCall(def.respawn, () => {
      if (token !== this.realmToken) return;        // realm changed; don't respawn here
      for (let i = 0; i < 30; i++) {
        const gx = Phaser.Math.Between(1, GRID - 2), gy = Phaser.Math.Between(1, GRID - 2);
        if (this.canSpawnAt(gx, gy)) { this.placeResource(gx, gy, node.kind); break; }
      }
    });
  }

  playTreeFall(node) {
    const s = node.sprite;
    if (!s || !s.active) return;                    // sprite already gone — nothing to topple
    if (node.shake) { node.shake.stop(); node.shake = null; }
    const dir = this.player.sprite.x < s.x ? 1 : -1;   // topple away from the player
    this.spawnLeaves(s.x, s.y - 36, 6);
    this.tweens.add({
      targets: s, angle: dir * 82, x: s.x + dir * 16, duration: 620, ease: 'Quad.in',
      onComplete: () => this.tweens.add({ targets: s, alpha: 0, duration: 280, onComplete: () => s.destroy() }),
    });
  }

  playRockBreak(node) {
    const s = node.sprite;
    if (!s || !s.active) return;
    this.sparkBurst(s.x, s.y - 14, 9, node.kind === 'coal' ? [0x9fd0ff, 0xcfeaff] : [0xffd07a, 0xff9a3d]);
    this.spawnPebbles(s.x, s.y - 10, 10, node.kind === 'coal' ? 'pebble_coal' : 'pebble');
    this.tweens.add({
      targets: s, scaleX: 0.2, scaleY: 0.2, alpha: 0, y: s.y + 4,
      duration: 300, ease: 'Quad.in', onComplete: () => s.destroy(),
    });
  }

  // ---- bots -----------------------------------------------------------------
  spawnBots(cfg) {
    // per-realm roles: anglers fish forever, visitors fish now and then, the rest wander
    this.bots = [];
    const conf = cfg.bots || { count: 8, anglers: 0, visitors: 0 };
    const n = conf.count, anglers = conf.anglers || 0, visitors = conf.visitors || 0, hunters = conf.hunters || 0,
      choppers = conf.choppers || 0, miners = conf.miners || 0;
    for (let i = 0; i < n; i++) {
      let gx, gy, tries = 0;
      do { gx = Phaser.Math.Between(2, GRID - 3); gy = Phaser.Math.Between(2, GRID - 3); }
      while (!this.isWalkable(gx, gy) && tries++ < 40);
      const role = i < anglers ? 'angler'
        : i < anglers + visitors ? 'visitor'
        : i < anglers + visitors + hunters ? 'hunter'
        : i < anglers + visitors + hunters + choppers ? 'chopper'
        : i < anglers + visitors + hunters + choppers + miners ? 'miner'
        : 'wander';
      const outfit = role === 'hunter' ? Phaser.Utils.Array.GetRandom(FIGHTERS) : Phaser.Utils.Array.GetRandom(TOWNSFOLK);
      const sprite = this.add.sprite(0, 0, 'axul', AXUL_ROW[outfit] * AXUL_COLS + AXUL_DIR_S)
        .setOrigin(0.5, 0.92).setScale(2.5);
      sprite.play(outfit + '_idle_' + AXUL_DIR_S);
      const label = this.add.text(0, 0, randomPlayerName(), {
        fontSize: '13px', color: role === 'hunter' ? '#ffd2d2' : '#dfe6ff', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 4,
      }).setOrigin(0.5, 1).setResolution(2);
      const b = { gx, gy, sprite, label, path: [], wait: Phaser.Math.FloatBetween(0, 2),
        role, hunter: role === 'hunter', fish: null, tool: null, directional: true, animSet: outfit, facingCol: AXUL_DIR_S };
      this.bots.push(b); this.placeEntity(b);
    }
  }

  updateBots(dt) {
    for (const b of this.bots) {
      if (b.fish) { this.updateBotFishing(b, dt); continue; }
      if (b.gather) { this.updateBotGather(b, dt); continue; }
      if (b.role === 'hunter') { this.updateBotHunt(b, dt); continue; }
      if (b.role === 'chopper') { this.updateBotWorker(b, dt, 'tree'); continue; }
      if (b.role === 'miner') { this.updateBotWorker(b, dt, 'rock'); continue; }

      if (b.role === 'angler') {                 // permanent fisher: always heading to fish
        if (b.wait > 0) { b.wait -= dt; this.placeEntity(b); continue; }
        if (!this.startBotFishing(b, true)) { b.wait = 2; this.placeEntity(b); continue; }
        this.updateBotFishing(b, dt); continue;
      }

      if (b.path.length) { this.stepAlongPath(b, dt, MOVE_SPEED * 0.55); }
      else if (b.wait > 0) { b.wait -= dt; }
      else {
        const roll = Math.random();
        if (roll < 0.55 && this.startBotGather(b)) { this.updateBotGather(b, dt); continue; }  // chop/mine
        if (b.role === 'visitor' && roll < 0.8 && this.startBotFishing(b, false)) { this.updateBotFishing(b, dt); continue; }
        let tx, ty, tries = 0;
        do { tx = Phaser.Math.Between(2, GRID - 3); ty = Phaser.Math.Between(2, GRID - 3); }
        while (!this.isWalkable(tx, ty) && tries++ < 20);
        const path = this.findPath(b.gx, b.gy, tx, ty);
        if (path && path.length) b.path = path; else b.wait = 1;
      }
      this.placeEntity(b);
    }
  }

  nearestCreeper(b) {
    let best = null, bd = Infinity;
    for (const e of (this.enemies || [])) {
      if (e.dead || e.kind !== 'creeper') continue;
      const d = Math.hypot(e.gx - b.gx, e.gy - b.gy);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  randomWalkTarget() {
    for (let i = 0; i < 20; i++) {
      const tx = Phaser.Math.Between(2, GRID - 3), ty = Phaser.Math.Between(2, GRID - 3);
      if (this.isWalkable(tx, ty)) return { x: tx, y: ty };
    }
    return null;
  }

  // wilderness "hunter" NPC: seek the nearest creeper, close in, and swing a sword at it
  updateBotHunt(b, dt) {
    if (!b.tool) b.tool = this.add.image(0, 0, 'tool_sword').setOrigin(0.5, 0.9).setScale(1.5);
    if (!b.target || b.target.dead) { b.target = this.nearestCreeper(b); b.repath = 0; }
    const e = b.target;
    if (!e) {                                            // no creepers around → wander
      if (b.path.length) this.stepAlongPath(b, dt, MOVE_SPEED * 0.55);
      else if (b.wait > 0) b.wait -= dt;
      else { const t = this.randomWalkTarget(); const p = t && this.findPath(b.gx, b.gy, t.x, t.y); if (p && p.length) b.path = p; else b.wait = 1; }
      if (b.tool) b.tool.setAngle(0);
      this.placeEntity(b); return;
    }
    const d = Math.hypot(e.gx - b.gx, e.gy - b.gy);
    if (d > 1.5) {                                       // approach the creeper (repath periodically as it moves)
      b.repath = (b.repath || 0) - dt;
      if (!b.path.length || b.repath <= 0) {
        const path = this.findPath(b.gx, b.gy, Math.round(e.gx), Math.round(e.gy));
        if (path && path.length) { path.pop(); b.path = path; }   // stop one tile short
        b.repath = 0.6;
      }
      if (b.path.length) this.stepAlongPath(b, dt, MOVE_SPEED * 0.62);
      if (b.tool) b.tool.setAngle(0);
    } else {                                             // in range → swing
      b.path = [];
      this.botFace(b, e.gx, e.gy);
      b.atk = (b.atk || 0) + dt;
      if (b.tool) b.tool.setAngle(-32 + Math.sin(b.atk * 16) * 40);
      if (b.atk >= ATTACK_INTERVAL) { b.atk = 0; this.damageEnemy(e, 3, false); }
    }
    this.placeEntity(b);
  }

  // dedicated chopper/miner NPC: keep walking to its resource type and working it
  updateBotWorker(b, dt, want) {
    if (b.path.length) { this.stepAlongPath(b, dt, MOVE_SPEED * 0.55); this.placeEntity(b); return; }
    if (b.wait > 0) { b.wait -= dt; this.placeEntity(b); return; }
    if (this.startBotGather(b, want)) { this.updateBotGather(b, dt); return; }
    b.wait = Phaser.Math.FloatBetween(0.5, 1.6);                  // no node free → retry shortly
    this.placeEntity(b);
  }

  // bots walk to a tree/rock and "work" it. `want` ('tree'|'rock') filters the target type.
  startBotGather(b, want) {
    let nodes = (this.resources || []).filter(r => r.amount > 0 && r.kind !== 'fish');
    if (want === 'tree') nodes = nodes.filter(r => r.kind === 'tree');
    else if (want === 'rock') nodes = nodes.filter(r => r.kind === 'rock' || r.kind === 'coal');
    if (!nodes.length) return false;
    let node = null, bd = Infinity;
    for (let i = 0; i < 6; i++) {
      const n = Phaser.Utils.Array.GetRandom(nodes), d = Math.hypot(n.gx - b.gx, n.gy - b.gy);
      if (d < bd) { bd = d; node = n; }
    }
    const stand = this.adjacentStand(node, b.gx, b.gy);
    if (!stand) return false;
    const path = this.findPath(b.gx, b.gy, stand.x, stand.y);
    if (!path) return false;
    b.path = path;
    b.tool = this.add.image(0, 0, node.kind === 'tree' ? 'tool_axe' : 'tool_pickaxe').setOrigin(0.5, 0.9).setScale(1.5);
    b.gather = { node, state: 'walking', timer: 0, dur: Phaser.Math.FloatBetween(5, 11), t: 0 };
    return true;
  }

  updateBotGather(b, dt) {
    const g = b.gather;
    if (g.node._gone || !g.node.sprite || !g.node.sprite.active) { this.stopBotGather(b); return; }   // node felled by someone else
    if (g.state === 'walking') {
      if (b.path.length) { this.stepAlongPath(b, dt, MOVE_SPEED * 0.55); this.placeEntity(b); return; }
      if (g.node.amount <= 0 || Math.max(Math.abs(g.node.gx - b.gx), Math.abs(g.node.gy - b.gy)) > 1.6) { this.stopBotGather(b); return; }
      this.botFace(b, g.node.gx, g.node.gy); g.state = 'working';
    }
    g.timer += dt; g.t += dt;
    if (b.tool) b.tool.setAngle(-32 + Math.sin(g.t * 13) * 38);     // swing the tool
    if (g.node.kind !== 'tree' && Math.random() < 0.04)
      this.sparkBurst(g.node.sprite.x, g.node.sprite.y - 14, 3, g.node.kind === 'coal' ? [0x9fd0ff, 0xcfeaff] : [0xffd07a, 0xff9a3d]);
    else if (g.node.kind === 'tree' && Math.random() < 0.03)
      this.spawnLeaves(g.node.sprite.x, g.node.sprite.y - 38, 1);
    if (g.timer >= g.dur || g.node.amount <= 0) {
      if (g.node.kind === 'tree' && !g.node._gone) this.depleteRespawn(g.node);   // NPC fells the tree (silent)
      this.stopBotGather(b); return;
    }
    this.placeEntity(b);
  }

  stopBotGather(b) {
    if (b.tool) { b.tool.destroy(); b.tool = null; }
    b.gather = null;
    b.wait = Phaser.Math.FloatBetween(1, 3);
  }

  // pick a random water tile with a reachable shore to fish from
  pickFishingSpot(fromGx, fromGy) {
    for (let i = 0; i < 25; i++) {
      const w = Phaser.Utils.Array.GetRandom(this.waterTiles);
      if (!w) return null;
      const stand = this.nearestWalkable(w.gx, w.gy);
      if (!stand) continue;
      const path = this.findPath(fromGx, fromGy, stand.x, stand.y);
      if (path) return { water: w, stand, path };
    }
    return null;
  }

  startBotFishing(b, permanent) {
    const spot = this.pickFishingSpot(b.gx, b.gy);
    if (!spot) return false;
    b.path = spot.path;
    b.tool = this.add.image(0, 0, 'tool_rod').setOrigin(0.5, 0.9).setScale(1.5);
    const bobber = this.add.image(0, 0, 'bobber').setOrigin(0.5).setVisible(false).setDepth(5001);
    const line = this.add.graphics().setDepth(5000);
    b.fish = {
      state: 'walking', wgx: spot.water.gx, wgy: spot.water.gy, timer: 0,
      waitDur: Phaser.Math.FloatBetween(4, 9), catches: 0,
      maxCatches: permanent ? Infinity : Phaser.Math.Between(2, 5),
      bobber, line, permanent, relocTimer: Phaser.Math.FloatBetween(120, 240),
    };
    return true;
  }

  stopBotFishing(b) {
    const f = b.fish; if (!f) return;
    if (f.bobber) f.bobber.destroy();
    if (f.line) f.line.destroy();
    if (b.tool) { b.tool.destroy(); b.tool = null; }
    b.fish = null;
    b.wait = Phaser.Math.FloatBetween(1, 3);
  }

  botRodTip(b) { const s = b.sprite, dir = s.flipX ? -1 : 1; return { x: s.x + dir * 10, y: s.y - 26 }; }
  botFace(b, gx, gy) { this.faceDir(b, gx - b.gx, gy - b.gy); }

  relocateBotAngler(b) {
    const f = b.fish;
    const spot = this.pickFishingSpot(b.gx, b.gy);
    if (!spot) { f.relocTimer = 30; return; }       // try again soon
    f.wgx = spot.water.gx; f.wgy = spot.water.gy;
    b.path = spot.path;
    f.state = 'walking'; f.timer = 0;
    f.relocTimer = Phaser.Math.FloatBetween(120, 240);
    f.bobber.setVisible(false); f.line.clear();
  }

  onBotCatch(b) {
    const f = b.fish;
    f.catches++;
    f.bobber.setVisible(false); f.line.clear();
    if (b.tool) b.tool.setAngle(0);
    if (!f.permanent && f.catches >= f.maxCatches) { this.stopBotFishing(b); return; }
    f.state = 'pause'; f.timer = 0;
  }

  updateBotFishing(b, dt) {
    const f = b.fish;
    if (f.state === 'walking') {
      if (b.path.length) { this.stepAlongPath(b, dt, MOVE_SPEED * 0.55); this.placeEntity(b); return; }
      this.botFace(b, f.wgx, f.wgy);
      f.state = 'casting'; f.timer = 0;
    }
    if (f.state === 'pause') {
      f.timer += dt;
      if (b.tool) b.tool.setAngle(0);
      if (f.timer >= 0.9) { f.state = 'casting'; f.timer = 0; f.waitDur = Phaser.Math.FloatBetween(4, 9); }
      this.placeEntity(b); return;
    }

    const rod = this.botRodTip(b);
    const water = { x: this.worldOX + isoX(f.wgx, f.wgy), y: this.worldOY + isoY(f.wgx, f.wgy) };
    const now = this.time.now;
    this.botFace(b, f.wgx, f.wgy);
    f.timer += dt;
    if (f.permanent) f.relocTimer -= dt;
    let bob, taut = false;

    if (f.state === 'casting') {
      const T = 0.45, t = Phaser.Math.Clamp(f.timer / T, 0, 1);
      b.tool.setAngle(-58 + 30 * t);
      bob = { x: Phaser.Math.Linear(rod.x, water.x, t), y: Phaser.Math.Linear(rod.y, water.y, t) - 30 * Math.sin(Math.PI * t) };
      if (t >= 1) { f.state = 'waiting'; f.timer = 0; }
    } else if (f.state === 'waiting') {
      b.tool.setAngle(-28);
      bob = { x: water.x, y: water.y + Math.sin(now * 0.004) * 1.6 };
      if (f.permanent && f.relocTimer <= 0) { this.relocateBotAngler(b); this.placeEntity(b); return; }
      if (f.timer >= f.waitDur) { f.state = 'bite'; f.timer = 0; }
    } else if (f.state === 'bite') {
      taut = true;
      bob = { x: water.x, y: water.y + Math.abs(Math.sin(now * 0.022)) * 4 };
      b.tool.setAngle(-28 + Math.sin(now * 0.03) * 5);
      if (f.timer >= 0.7) { f.state = 'reeling'; f.timer = 0; }
    } else if (f.state === 'reeling') {
      taut = true;
      const T = 0.6, t = Phaser.Math.Clamp(f.timer / T, 0, 1);
      b.tool.setAngle(-58 - 8 * Math.sin(Math.PI * t));
      bob = { x: Phaser.Math.Linear(water.x, rod.x, t), y: Phaser.Math.Linear(water.y, rod.y, t) - 20 * Math.sin(Math.PI * t) };
      if (t >= 1) { this.onBotCatch(b); this.placeEntity(b); return; }
    }

    f.bobber.setVisible(true).setPosition(bob.x, bob.y).setDepth(5001);
    this.strokeFishLine(f.line, rod, bob, taut);
    this.placeEntity(b);
  }

  // ---- player ---------------------------------------------------------------
  spawnPlayer() {
    const gx = Math.round(GRID / 2), gy = Math.round(GRID / 2);
    const sprite = this.add.sprite(0, 0, 'axul', AXUL_ROW.boy * AXUL_COLS + AXUL_DIR_S)
      .setOrigin(0.5, 0.92).setScale(2.5);
    sprite.play('boy_idle_' + AXUL_DIR_S);
    const label = this.add.text(0, 0, 'Guest', {
      fontSize: '14px', color: '#bff0ff', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 4,
    }).setOrigin(0.5, 1).setResolution(2);
    const tool = this.add.image(0, 0, 'tool_axe').setOrigin(0.5, 0.9).setScale(1.55).setAngle(18).setVisible(true);
    const shadow = this.add.ellipse(0, 0, 26, 12, 0x000000, 0.3);
    this.player = {
      gx, gy, sprite, label, tool, shadow,
      directional: true, animSet: 'boy', facingCol: AXUL_DIR_S,
      path: [], gatherTarget: null, gatherTimer: 0, gatherDur: 1, swing: null,
      fishing: null,
      combatTarget: null, attackTimer: 0, attackSwing: null,
      hp: PLAYER_MAXHP, maxHp: PLAYER_MAXHP, hurtCd: 0, regenCd: 0, dead: false,
      equipped: 'axe',
      tools: { axe: 1, pickaxe: 1, rod: 1, sword: 1 },
      owned: { axe: false, pickaxe: false, rod: false, sword: false },   // collected from stations
      learned: { chop: false, fish: false, mine: false, fight: false },  // tutorial progress
      inv: { wood: 0, stone: 0, coal: 0, fish: 0, cookedfish: 0, coins: 0 }, bank: { wood: 0, stone: 0, coal: 0, fish: 0, cookedfish: 0, coins: 0 }, listings: [],
      skills: { woodcutting: { level: 1, xp: 0 }, mining: { level: 1, xp: 0 }, fishing: { level: 1, xp: 0 }, combat: { level: 1, xp: 0 }, cooking: { level: 1, xp: 0 }, smithing: { level: 1, xp: 0 } },
      warnedWild: false,                                                 // shown the danger-zone warning yet?
      saveKey: 'guest',
    };
    this.placeEntity(this.player);
    this.updateToolSprite();
  }

  placeEntity(e) {
    const x = this.worldOX + isoX(e.gx, e.gy);
    const y = this.worldOY + isoY(e.gx, e.gy);
    if (e.shadow) { e.shadow.setPosition(x, y + 6).setDepth(isoDepth(e.gx, e.gy) + 0.5); }
    e.sprite.setPosition(x, y + 6);
    e.sprite.setDepth(isoDepth(e.gx, e.gy) + 0.6);
    e.label.setPosition(x, y - 40);
    e.label.setDepth(99999);
    if (e.tool) {
      const side = e.toolSide || 1;                       // which hand/side the tool is on
      e.tool.setPosition(x + 7 * side, y - 13);           // at the character's hand
      e.tool.setDepth(isoDepth(e.gx, e.gy) + 0.7);        // in front of the character
    }
  }

  // moves an entity one frame toward the next waypoint; returns true if arrived at a node
  stepAlongPath(e, dt, speed) {
    if (!e.path.length) return;
    const wp = e.path[0];
    const dx = wp.x - e.gx, dy = wp.y - e.gy;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= step) { e.gx = wp.x; e.gy = wp.y; e.path.shift(); }
    else { e.gx += (dx / dist) * step; e.gy += (dy / dist) * step; }
    // face by horizontal screen direction (directional sprites handle facing via animation row)
    if (!e.directional && Math.abs(dx - dy) > 0.001) e.sprite.setFlipX((dx - dy) < 0);
  }

  // =========================================================================
  //  Input
  // =========================================================================
  setupInput() {
    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,ONE,TWO,THREE,FOUR,U,C,E,M,T');

    // clicking an interactive object (tree/NPC/enemy) is handled by its own
    // handler on pointerdown; flag it so the ground click on pointerup skips it.
    this.input.on('gameobjectdown', () => { this.objClicked = true; });

    // left-button press begins a potential camera drag; a plain click (no drag)
    // becomes a move/interact on release. Right button is ignored.
    this.input.on('pointerdown', (p) => {
      if (p.rightButtonDown && p.rightButtonDown()) return;
      this.objClicked = false;
      this.panActive = true; this.didDrag = false;
      this.panStartX = p.x; this.panStartY = p.y;
      this.panLastX = p.x; this.panLastY = p.y;
    });

    this.input.on('pointerup', (p) => {
      const wasPan = this.panActive; this.panActive = false;
      if (!wasPan) return;                              // press began on an object / off-canvas
      if (this.didDrag) { this.didDrag = false; return; }   // it was a camera drag, not a click
      if (this.objClicked || this.dlgOpen) return;      // object handled it, or dialogue is open
      const { gx, gy } = this.screenToGrid(p);
      const b = this.buildingAtTile(gx, gy);
      if (b) { this.onBuildingClick(b); return; }       // clicked a building/NPC tile
      this.pendingBuilding = null;
      if (this.isWater(gx, gy)) { this.startFishing(gx, gy); return; }
      this.cancelGather(); this.cancelFishing(); this.clearCombat();
      this.moveTo(gx, gy, true);
    });

    // mouse wheel / trackpad pinch: scroll up = zoom in, scroll down = zoom out
    this.input.on('wheel', (pointer, over, dx, dy) => {
      const ev = pointer.event; if (ev && ev.cancelable) ev.preventDefault();
      const cam = this.cameras.main;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * Math.exp(-dy * 0.0015), this.minZoom || ZOOM_MIN, ZOOM_MAX));
    });

    // keyboard zoom: '=' in, '-' out
    this.keyZoomIn = this.input.keyboard.addKey(187);
    this.keyZoomOut = this.input.keyboard.addKey(189);

    // hover highlight
    this.hover = this.add.image(0, 0, 'hi').setAlpha(0.18).setVisible(false).setDepth(50);
    this.input.on('pointermove', (p) => {
      // left-button hold + drag pans the camera (detaches follow)
      if (this.panActive && p.leftButtonDown && p.leftButtonDown()) {
        if (!this.didDrag && Math.hypot(p.x - this.panStartX, p.y - this.panStartY) > 6) {
          this.didDrag = true; this.detachCamera();
        }
        if (this.didDrag) {
          const cam = this.cameras.main;
          cam.scrollX -= (p.x - this.panLastX) / cam.zoom;
          cam.scrollY -= (p.y - this.panLastY) / cam.zoom;
        }
        this.panLastX = p.x; this.panLastY = p.y;
      }
      const { gx, gy } = this.screenToGrid(p);
      if (this.inBounds(gx, gy)) {
        this.hover.setVisible(true).setPosition(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy))
          .setDepth(-9000 + isoDepth(gx, gy));
      } else { this.hover.setVisible(false); }
    });

    // click marker pool
    this.clickMark = this.add.image(0, 0, 'hi').setVisible(false).setDepth(60);
  }

  screenToGrid(pointer) {
    const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const X = wp.x - this.worldOX, Y = wp.y - this.worldOY;
    const gx = Math.round(X / TILE_W + Y / TILE_H);
    const gy = Math.round(Y / TILE_H - X / TILE_W);
    return { gx, gy };
  }

  // camera control: panning detaches and STAYS put; only C re-centers.
  detachCamera() {
    if (this.cameraFollowing) {
      this.cameras.main.stopFollow();
      this.cameraFollowing = false;
    }
  }
  recenterCamera() {
    const cam = this.cameras.main;
    cam.centerOn(this.player.sprite.x, this.player.sprite.y);   // instant snap, no lerp
    cam.startFollow(this.player.sprite, false, 0.12, 0.12);
    this.cameraFollowing = true;
  }
  zoomBy(d) {
    const cam = this.cameras.main;
    cam.setZoom(Phaser.Math.Clamp(cam.zoom + d, this.minZoom || ZOOM_MIN, ZOOM_MAX));
  }

  // ---- cinematic "director mode" for trailer capture (press T) ---------------
  toggleCinematic() {
    if (this.cine && this.cine.intro) { this.exitIntro(); return; }   // intro: any toggle just starts the game
    (this.cine && this.cine.on) ? this.exitCinematic() : this.enterCinematic();
  }

  initCinematicOverlay() {
    if (this.cineEl) return;
    const css = document.createElement('style');
    css.textContent = `
      #cine-overlay{position:absolute;inset:0;z-index:60;pointer-events:none;display:none;font-family:'Arial Black','Segoe UI',system-ui,sans-serif;}
      body.cinematic > *:not(#game):not(#cine-overlay){display:none !important;}
      body.cinematic #cine-overlay{display:block;}
      .cine-bar{position:absolute;left:0;right:0;height:9vh;background:#000;}
      .cine-bar.top{top:0;} .cine-bar.bottom{bottom:0;}
      #cine-title{position:absolute;top:33%;left:0;right:0;text-align:center;opacity:0;transition:opacity 1s ease;}
      #cine-title.pop{animation:cinePop 1s ease both;}
      @keyframes cinePop{0%{transform:scale(.8);}60%{transform:scale(1.05);}100%{transform:scale(1);}}
      #cine-title .t{display:inline-block;font-weight:900;font-size:clamp(54px,11vw,132px);letter-spacing:2px;line-height:.9;
        text-transform:uppercase;color:#ffd24a;-webkit-text-stroke:5px #2a1a52;paint-order:stroke fill;
        text-shadow:0 3px 0 #c98a1e,0 6px 0 #b3781a,0 9px 0 #8f5f12,0 12px 0 #6b470d,0 16px 24px rgba(0,0,0,.65),0 0 40px rgba(124,92,255,.45);}
      #cine-title .s{display:block;margin-top:20px;font-size:clamp(13px,1.8vw,21px);font-weight:800;letter-spacing:11px;
        text-transform:uppercase;color:#bfe6ff;text-shadow:0 2px 8px #000,0 0 18px rgba(90,209,255,.5);}
      #cine-label{position:absolute;left:48px;bottom:13vh;color:#fff;font-size:23px;font-weight:900;letter-spacing:2px;text-shadow:0 2px 10px #000;opacity:0;transition:opacity .6s ease;text-transform:uppercase;}
      #cine-label::before{content:'';display:inline-block;width:11px;height:11px;border-radius:50%;background:#ff5a5a;margin-right:11px;vertical-align:middle;box-shadow:0 0 9px #ff5a5a;animation:cineRec 1s steps(2) infinite;}
      @keyframes cineRec{50%{opacity:.25;}}
      #cine-hint{position:absolute;right:24px;bottom:11vh;color:#8ea0c8;font-size:13px;letter-spacing:1px;text-shadow:0 1px 3px #000;font-family:'Segoe UI',system-ui;}
    `;
    document.head.appendChild(css);
    const ov = document.createElement('div'); ov.id = 'cine-overlay';
    ov.innerHTML = `<div class="cine-bar top"></div><div class="cine-bar bottom"></div>
      <div id="cine-title"><span class="t">PixelQuest</span><span class="s">An Isometric Adventure</span></div>
      <div id="cine-label"></div><div id="cine-hint">press T to exit</div>`;
    document.body.appendChild(ov); this.cineEl = ov;
  }

  // intro on first load: the cinematic "Welcome to PixelQuest" shot (slow push-in over
  // the town with the logo + letterbox), held until the player clicks to play.
  startIntroCinematic() {
    this.initCinematicOverlay();
    const cam = this.cameras.main, cfg = this.realmCfg;
    const gx = cfg.plaza ? cfg.plaza.cx : this.player.gx, gy = cfg.plaza ? cfg.plaza.cy : this.player.gy;
    const wx = this.worldOX + isoX(gx, gy), wy = this.worldOY + isoY(gx, gy);
    this.cine = { on: true, intro: true };
    document.body.classList.add('cinematic');
    this.input.enabled = false;
    cam.stopFollow(); this.cameraFollowing = false;
    if (this.coordText) this.coordText.setVisible(false);
    if (this.guideArrow) this.guideArrow.setVisible(false);
    cam.centerOn(wx, wy); cam.setZoom(1.02);
    cam.zoomTo(1.32, 9000, 'Sine.easeInOut');        // slow push-in, then holds
    const t = document.getElementById('cine-title');
    if (t) { t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); t.style.opacity = '1'; }   // logo stays up
    const hint = document.getElementById('cine-hint'); if (hint) hint.textContent = '▶ click to play';
    window.addEventListener('pointerdown', () => this.exitIntro(), { once: true });   // click anywhere starts the game (also unlocks audio)
  }

  exitIntro() {
    if (!this.cine || !this.cine.intro) return;
    const cam = this.cameras.main;
    this.cine = null;
    document.body.classList.remove('cinematic');
    this.input.enabled = true;
    if (this.coordText) this.coordText.setVisible(true);
    const t = document.getElementById('cine-title'); if (t) t.style.opacity = '0';
    const hint = document.getElementById('cine-hint'); if (hint) hint.textContent = 'press T to exit';
    cam.pan(this.player.sprite.x, this.player.sprite.y, 650, 'Sine.easeInOut');
    cam.zoomTo(1.2, 650, 'Sine.easeInOut');
    this.time.delayedCall(680, () => { cam.startFollow(this.player.sprite, false, 0.12, 0.12); this.cameraFollowing = true; });
  }

  // which realms the tour visits (and in what order), starting from where you are
  cineRealms() { return this.realm === 'wilderness' ? ['wilderness', 'mainland'] : ['mainland', 'wilderness']; }

  // tour stops drawn from the realm's points of interest (bots are already working there)
  buildCineShots() {
    const cfg = this.realmCfg, shots = [];
    const add = (gx, gy, zoom, label) => shots.push({ gx, gy, zoom, label });
    if (cfg.biome === 'wild') add(this.player.gx, this.player.gy, 1.3, 'The Wilderness');
    if (cfg.plaza) add(cfg.plaza.cx, cfg.plaza.cy, 1.25, 'Welcome to PixelQuest');
    if (cfg.treeArea) add(cfg.treeArea.cx, cfg.treeArea.cy, 1.6, 'Woodcutting');
    if (cfg.rockArea) add(cfg.rockArea.cx, cfg.rockArea.cy, 1.6, 'Mining');
    if (this.waterTiles && this.waterTiles.length) {                 // pond centre → fishing
      let sx = 0, sy = 0; for (const t of this.waterTiles) { sx += t.gx; sy += t.gy; }
      add(Math.round(sx / this.waterTiles.length), Math.round(sy / this.waterTiles.length), 1.6, 'Fishing');
    }
    if (cfg.arena) add(cfg.arena.cx, cfg.arena.cy, 1.7, 'Arena Combat');
    const creepers = (this.enemies || []).filter(e => !e.dead && e.kind === 'creeper');   // wilderness battles
    if (creepers.length) {
      const a = creepers[0], b = creepers[Math.floor(creepers.length / 2)];
      add(Math.round(a.gx), Math.round(a.gy), 1.75, 'Hunters vs Creepers');
      if (b !== a) add(Math.round(b.gx), Math.round(b.gy), 1.8, 'Creeper Combat');
    }
    if (!shots.length) add(this.player.gx, this.player.gy, 1.4, 'PixelQuest');
    return shots;
  }

  enterCinematic() {
    this.initCinematicOverlay();
    const cam = this.cameras.main;
    this.cine = { on: true, realms: this.cineRealms(), ri: 0, idx: -1, shots: [], timer: null, prevRealm: this.realm, prevZoom: cam.zoom };
    document.body.classList.add('cinematic');
    this.input.enabled = false;                                      // freeze clicks/drag (keyboard still works for T)
    cam.stopFollow(); this.cameraFollowing = false;
    this.player.path = [];
    if (this.coordText) this.coordText.setVisible(false);
    if (this.guideArrow) this.guideArrow.setVisible(false);
    this.showCineTitle();
    if (this.realm === this.cine.realms[0]) { this.cine.shots = this.buildCineShots(); this.nextCineShot(); }
    else this.cineGotoRealm(this.cine.realms[0]);
  }

  nextCineShot() {
    if (!this.cine || !this.cine.on) return;
    const c = this.cine;
    if (++c.idx >= c.shots.length) {                                 // realm done → travel to the next realm (loops)
      c.ri = (c.ri + 1) % c.realms.length; c.idx = -1;
      this.cineGotoRealm(c.realms[c.ri]); return;
    }
    const cam = this.cameras.main, s = c.shots[c.idx];
    const wx = this.worldOX + isoX(s.gx, s.gy), wy = this.worldOY + isoY(s.gx, s.gy);
    const dur = 5200;
    cam.pan(wx, wy, dur, 'Sine.easeInOut');
    cam.zoomTo(s.zoom, dur, 'Sine.easeInOut');
    this.showCineLabel(s.label);
    c.timer = this.time.delayedCall(dur + 600, () => this.nextCineShot());
  }

  // fade out, rebuild the target realm, then resume the tour there
  cineGotoRealm(realm) {
    if (!this.cine || !this.cine.on) return;
    const cam = this.cameras.main;
    if (realm === this.realm) { this.cine.shots = this.buildCineShots(); this.nextCineShot(); return; }
    cam.fadeOut(450, 6, 12, 26);
    cam.once('camerafadeoutcomplete', () => {
      if (!this.cine || !this.cine.on) return;
      this.clearRealm(); this.buildRealm(realm);
      const sp = REALMS[realm].spawn;
      this.player.gx = sp.x; this.player.gy = sp.y; this.player.path = [];
      this.placeEntity(this.player);
      cam.stopFollow(); this.cameraFollowing = false;
      cam.centerOn(this.player.sprite.x, this.player.sprite.y);
      if (this.coordText) this.coordText.setVisible(false);
      if (this.guideArrow) this.guideArrow.setVisible(false);
      this.cine.shots = this.buildCineShots();
      cam.fadeIn(450, 6, 12, 26);
      this.time.delayedCall(550, () => this.nextCineShot());
    });
  }

  showCineTitle() {
    const t = document.getElementById('cine-title'); if (!t) return;
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');   // retrigger the pop animation
    t.style.opacity = '1';
    this.time.delayedCall(3800, () => { if (this.cine && this.cine.on) t.style.opacity = '0'; });
  }
  showCineLabel(text) {
    const l = document.getElementById('cine-label'); if (!l) return;
    l.textContent = text; l.style.opacity = '1';
    this.time.delayedCall(2800, () => { if (l.textContent === text) l.style.opacity = '0'; });
  }

  exitCinematic() {
    if (!this.cine) return;
    const c = this.cine, cam = this.cameras.main;
    if (c.timer) c.timer.remove();
    c.on = false;
    document.body.classList.remove('cinematic');
    this.input.enabled = true;
    if (this.coordText) this.coordText.setVisible(true);
    cam.setZoom(c.prevZoom || 1.2);
    if (this.realm !== c.prevRealm) {
      this.travelTo(c.prevRealm);                                    // return to where we started (handles fade + follow)
    } else {
      cam.pan(this.player.sprite.x, this.player.sprite.y, 500, 'Sine.easeInOut');
      this.time.delayedCall(520, () => { cam.startFollow(this.player.sprite, false, 0.12, 0.12); this.cameraFollowing = true; });
    }
    this.cine = null;
  }

  moveTo(gx, gy, showMark) {
    let tx = gx, ty = gy;
    if (!this.isWalkable(tx, ty)) {           // clicked water/obstacle -> nearest walkable
      const near = this.nearestWalkable(tx, ty);
      if (!near) return; tx = near.x; ty = near.y;
    }
    const path = this.findPath(this.player.gx, this.player.gy, tx, ty);
    if (path) {
      this.player.path = path;
      if (showMark) this.pingMark(tx, ty);
    }
  }

  nearestWalkable(gx, gy) {
    for (let r = 1; r <= 6; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          if (this.isWalkable(gx + dx, gy + dy)) return { x: gx + dx, y: gy + dy };
    return null;
  }

  pingMark(gx, gy) {
    const m = this.clickMark;
    m.setVisible(true).setAlpha(0.6).setScale(1)
      .setPosition(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy))
      .setDepth(-8000 + isoDepth(gx, gy));
    this.tweens.killTweensOf(m);
    this.tweens.add({ targets: m, alpha: 0, scaleX: 0.5, scaleY: 0.5, duration: 450 });
  }

  // =========================================================================
  //  Gathering
  // =========================================================================
  onResourceClick(node) {
    const def = NODES[node.kind];
    if (!this.player.owned[def.tool]) {            // tutorial: must collect the tool from its station first
      this.toast(`Find the ${TOOLS[def.tool].name} first!`, 'warn'); return;
    }
    if (this.player.equipped !== def.tool) {       // must equip the right tool yourself
      const key = TOOL_ORDER.indexOf(def.tool) + 1;
      this.toast(`${TOOLS[def.tool].name} not equipped — press ${key}`, 'warn');
      return;
    }
    this.cancelFishing();
    const stand = this.adjacentStand(node, this.player.gx, this.player.gy);
    if (!stand) { this.toast('Can\'t reach that', 'warn'); return; }
    const path = this.findPath(this.player.gx, this.player.gy, stand.x, stand.y);
    if (path === null) { this.toast('Can\'t reach that', 'warn'); return; }
    this.player.path = path;
    this.player.gatherTarget = node;
    this.pingMark(node.gx, node.gy);
  }

  adjacentToNode(node) {
    return Math.max(Math.abs(node.gx - this.player.gx), Math.abs(node.gy - this.player.gy)) <= 1.4;
  }

  startGather() {
    const node = this.player.gatherTarget, def = NODES[node.kind];
    const tier = this.player.tools[def.tool];
    const lvl = this.player.skills[def.skill].level;
    this.player.gatherDur = def.base * TIER[tier].speed * (1 - 0.015 * (lvl - 1));
    this.player.gatherTimer = 0;
    // step right up against the node instead of standing a full tile away
    this.player.gx = node.gx + (this.player.gx - node.gx) * 0.5;
    this.player.gy = node.gy + (this.player.gy - node.gy) * 0.5;
    this.placeEntity(this.player);
    // face the node
    const dx = node.gx - this.player.gx, dy = node.gy - this.player.gy;
    this.faceDir(this.player, dx, dy);
    // put the tool on the side toward the tree, blade facing it, and chop overhead
    const toRight = (dx - dy) >= 0;
    const t = this.player.tool;
    this.player.toolSide = toRight ? 1 : -1;
    t.setFlipX(toRight);                                      // blade native-left -> flip to face a right-side tree
    this.placeEntity(this.player);
    if (this.player.swing) this.player.swing.stop();
    const a0 = toRight ? -55 : 55, a1 = toRight ? 28 : -28;   // overhead -> down toward the tree
    t.setAngle(a0);
    this.player.swing = this.tweens.add({
      targets: t, angle: a1, duration: 230, yoyo: true, repeat: -1, ease: 'Sine.inOut',
    });
    // a tree visibly shakes while it's being chopped
    if (node.kind === 'tree') {
      node.sprite.setAngle(0);
      node.shake = this.tweens.add({
        targets: node.sprite, angle: { from: -3.5, to: 3.5 }, duration: 90,
        yoyo: true, repeat: -1, ease: 'Sine.inOut',
      });
      this.gatherShakeNode = node;
    }
  }

  finishGatherTick() {
    const node = this.player.gatherTarget;
    if (!node || node._gone || !node.sprite || !node.sprite.active) { this.cancelGather(); return; }
    const def = NODES[node.kind];
    const tier = this.player.tools[def.tool];
    const gained = TIER[tier].yield;
    node.amount -= 1;
    this.player.inv[def.item] += gained;
    this.sfx(node.kind === 'tree' ? 'chop' : 'mine');
    this.floatGain(node.gx, node.gy, gained, this.itemIconKey(def.item));
    this.addXP(def.skill, Math.round(def.xp * TIER[tier].xpMult));
    this.refreshInventory();
    this.saveProfile();
    // per-hit impact: leaves shaken off a tree, sparks + crumbling stone off rock/coal
    if (node.kind === 'tree') {
      this.spawnLeaves(node.sprite.x, node.sprite.y - 38, 2);
    } else {
      this.sparkBurst(node.sprite.x, node.sprite.y - 14, 5,
        node.kind === 'coal' ? [0x9fd0ff, 0xcfeaff] : [0xffd07a, 0xff9a3d]);
      this.spawnPebbles(node.sprite.x, node.sprite.y - 10, 4, node.kind === 'coal' ? 'pebble_coal' : 'pebble');
    }
    if (node.amount <= 0) {
      this.learn(node.kind === 'tree' ? 'chop' : 'mine');   // objective: fully harvest the node, not just one hit
      if (node.shake) { node.shake.stop(); node.shake = null; }
      this.gatherShakeNode = null;           // hand the angle over to the fall animation
      this.depleteRespawn(node);
      this.cancelGather();
    } else { this.player.gatherTimer = 0; }   // keep swinging for the next unit
  }

  cancelGather() {
    this.player.gatherTarget = null;
    this.player.gatherTimer = 0;
    if (this.player.swing) { this.player.swing.stop(); this.player.swing = null; }
    this.player.toolSide = 1;
    this.player.tool.setFlipX(false).setAngle(this.player.equipped === 'rod' ? -8 : 18);
    this.placeEntity(this.player);
    // stop shaking a tree we walked away from mid-chop
    const n = this.gatherShakeNode;
    if (n) {
      if (n.shake) { n.shake.stop(); n.shake = null; }
      if (n.sprite && n.sprite.active) n.sprite.setAngle(0);
      this.gatherShakeNode = null;
    }
  }

  // small particle bursts for gathering feedback
  sparkBurst(x, y, n, tints) {
    for (let i = 0; i < n; i++) {
      const sp = this.add.image(x, y, 'spark').setDepth(9000)
        .setTint(Phaser.Utils.Array.GetRandom(tints)).setScale(Phaser.Math.FloatBetween(0.7, 1.3));
      const ang = Phaser.Math.FloatBetween(-Math.PI, 0), dist = Phaser.Math.FloatBetween(10, 26);
      this.tweens.add({
        targets: sp, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist,
        alpha: 0, scaleX: 0.2, scaleY: 0.2, duration: Phaser.Math.Between(260, 440),
        ease: 'Quad.out', onComplete: () => sp.destroy(),
      });
    }
  }

  spawnLeaves(x, y, n) {
    for (let i = 0; i < n; i++) {
      const lf = this.add.image(x + Phaser.Math.Between(-12, 12), y, 'leaf').setDepth(9000)
        .setAlpha(0.9).setAngle(Phaser.Math.Between(0, 360));
      this.tweens.add({
        targets: lf, y: y + Phaser.Math.Between(24, 42), x: lf.x + Phaser.Math.Between(-10, 10),
        angle: lf.angle + Phaser.Math.Between(-120, 120), alpha: 0,
        duration: Phaser.Math.Between(600, 1000), ease: 'Sine.in', onComplete: () => lf.destroy(),
      });
    }
  }

  // stone chunks that pop off and tumble/crumble downward off a mined node
  spawnPebbles(x, y, n, texKey) {
    for (let i = 0; i < n; i++) {
      const p = this.add.image(x + Phaser.Math.Between(-4, 4), y + Phaser.Math.Between(-2, 2), texKey)
        .setDepth(9001).setScale(Phaser.Math.FloatBetween(0.9, 1.5)).setAngle(Phaser.Math.Between(0, 360));
      const side = Phaser.Math.FloatBetween(-1, 1);
      const outX = (8 + Math.random() * 14) * (side < 0 ? -1 : 1);
      const up = Phaser.Math.Between(8, 16), fall = Phaser.Math.Between(24, 40);
      const spin = Phaser.Math.Between(-220, 220);
      // pop up & out…
      this.tweens.add({
        targets: p, x: p.x + outX * 0.5, y: p.y - up, angle: p.angle + spin * 0.4,
        duration: Phaser.Math.Between(140, 200), ease: 'Quad.out',
        onComplete: () => {
          // …then fall down past the node and fade
          this.tweens.add({
            targets: p, x: p.x + outX * 0.5, y: p.y + up + fall, angle: p.angle + spin * 0.6,
            alpha: 0, duration: Phaser.Math.Between(380, 540), ease: 'Quad.in',
            onComplete: () => p.destroy(),
          });
        },
      });
    }
  }


  // =========================================================================
  //  Fishing — click any water tile: walk to shore, cast, wait, bite, reel in
  // =========================================================================
  startFishing(gx, gy) {
    if (this.player.equipped !== 'rod') {          // must equip the rod yourself
      this.toast('Fishing Rod not equipped — press 3', 'warn');
      return;
    }
    this.cancelGather();
    this.cancelFishing();
    this.clearCombat();
    const stand = this.nearestWalkable(gx, gy);
    if (!stand) { this.toast("Can't reach that water", 'warn'); return; }
    const path = this.findPath(this.player.gx, this.player.gy, stand.x, stand.y);
    if (path === null) { this.toast("Can't reach that water", 'warn'); return; }
    this.player.path = path;
    const bobber = this.add.image(0, 0, 'bobber').setOrigin(0.5).setVisible(false).setDepth(5001);
    this.player.fishing = { state: 'walking', wgx: gx, wgy: gy, timer: 0, waitDur: FISH.base,
      bobber, hooked: null, biteMark: null };
    this.pingMark(gx, gy);
  }

  cancelFishing() {
    const f = this.player && this.player.fishing;
    if (!f) return;
    if (f.bobber) f.bobber.destroy();
    if (f.hooked) f.hooked.destroy();
    if (f.biteMark) f.biteMark.destroy();
    if (this.fishLine) this.fishLine.clear();
    if (this.player.equipped === 'rod') this.player.tool.setAngle(0);
    this.player.fishing = null;
  }

  rodTip() {
    const s = this.player.sprite, dir = s.flipX ? -1 : 1;
    return { x: s.x + dir * 12, y: s.y - 30 };
  }

  faceTile(gx, gy) {
    const dx = gx - this.player.gx, dy = gy - this.player.gy;
    this.faceDir(this.player, dx, dy);
  }

  handleFishing(dt) {
    const f = this.player.fishing;
    if (!f) return;
    // walk to the shore first
    if (f.state === 'walking') {
      if (this.player.path.length) return;
      this.faceTile(f.wgx, f.wgy);
      const tier = this.player.tools.rod, lvl = this.player.skills.fishing.level;
      f.waitDur = FISH.base * TIER[tier].speed * (1 - 0.015 * (lvl - 1));
      f.state = 'casting'; f.timer = 0; this.sfx('cast');
      return;
    }

    const rod = this.rodTip();
    const water = { x: this.worldOX + isoX(f.wgx, f.wgy), y: this.worldOY + isoY(f.wgx, f.wgy) };
    const now = this.time.now;
    this.faceTile(f.wgx, f.wgy);
    f.timer += dt;
    let bob, taut = false;

    if (f.state === 'casting') {                         // flick the rod, line arcs out
      const T = 0.45, t = Phaser.Math.Clamp(f.timer / T, 0, 1);
      this.player.tool.setAngle(-58 + 30 * t);
      bob = { x: Phaser.Math.Linear(rod.x, water.x, t), y: Phaser.Math.Linear(rod.y, water.y, t) - 34 * Math.sin(Math.PI * t) };
      if (t >= 1) { f.state = 'waiting'; f.timer = 0; }
    } else if (f.state === 'waiting') {                  // bobber floats, waiting ~5s for a bite
      this.player.tool.setAngle(-28);
      bob = { x: water.x, y: water.y + Math.sin(now * 0.004) * 1.6 };
      if (f.timer >= f.waitDur) { f.state = 'bite'; f.timer = 0; this.showBite(f, bob); }
    } else if (f.state === 'bite') {                     // bobber jerks, line goes taut
      taut = true;
      bob = { x: water.x, y: water.y + Math.abs(Math.sin(now * 0.022)) * 4 };
      this.player.tool.setAngle(-28 + Math.sin(now * 0.03) * 5);
      if (f.biteMark) f.biteMark.setPosition(bob.x, bob.y - 16);
      if (f.timer >= 0.9) { f.state = 'reeling'; f.timer = 0; this.hideBite(f); this.spawnHooked(f); }
    } else if (f.state === 'reeling') {                  // pull the fish back along the line
      taut = true;
      const T = 0.6, t = Phaser.Math.Clamp(f.timer / T, 0, 1);
      this.player.tool.setAngle(-58 - 8 * Math.sin(Math.PI * t));
      bob = { x: Phaser.Math.Linear(water.x, rod.x, t), y: Phaser.Math.Linear(water.y, rod.y, t) - 22 * Math.sin(Math.PI * t) };
      if (f.hooked) { f.hooked.setPosition(bob.x, bob.y + 5); f.hooked.setFlipX(this.player.sprite.flipX); }
      if (t >= 1) { this.catchFish(f); return; }
    }

    f.bobber.setVisible(true).setPosition(bob.x, bob.y).setDepth(5001);
    this.drawFishLine(rod, bob, taut);
  }

  drawFishLine(rod, bob, taut) { this.strokeFishLine(this.fishLine, rod, bob, taut); }

  strokeFishLine(g, rod, bob, taut) {
    g.clear();
    g.lineStyle(1.4, 0xeaf2ff, 0.8);
    const sag = taut ? 2 : 9, pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(new Phaser.Math.Vector2(
        Phaser.Math.Linear(rod.x, bob.x, t),
        Phaser.Math.Linear(rod.y, bob.y, t) + sag * Math.sin(Math.PI * t)));
    }
    g.strokePoints(pts);
  }

  showBite(f, bob) {
    f.biteMark = this.add.text(bob.x, bob.y - 16, '!', {
      fontSize: '20px', color: '#ffe14d', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(5003);
    this.tweens.add({ targets: f.biteMark, scale: { from: 0.5, to: 1.2 }, duration: 160, yoyo: true, repeat: 4 });
  }
  hideBite(f) { if (f.biteMark) { f.biteMark.destroy(); f.biteMark = null; } }

  spawnHooked(f) { f.hooked = this.add.image(0, 0, 'fish_caught').setOrigin(0.5).setDepth(5002); }

  catchFish(f) {
    const tier = this.player.tools.rod;     // tier speeds the bite & boosts XP, but the catch is always 1
    this.player.inv.fish += 1;
    this.sfx('catch');
    this.learn('fish');
    this.addXP('fishing', Math.round(FISH.xp * TIER[tier].xpMult));
    this.floatGain(this.player.gx, this.player.gy, 1, 'ic_fish');
    this.refreshInventory(); this.saveProfile();
    this.toast('Caught a fish!', 'level');
    if (f.hooked) {
      const h = f.hooked; f.hooked = null;
      this.tweens.add({ targets: h, y: h.y - 16, alpha: 0, duration: 380, onComplete: () => h.destroy() });
    }
    this.cancelFishing();                                // stop after one catch — click the water to fish again
  }

  // ambient fish shadows drifting around the pond
  spawnFishShadows(n) {
    this.fishShadows = [];
    const water = this.tiles.filter(t => t.water);
    if (!water.length) return;
    for (let i = 0; i < n; i++) {
      const t = Phaser.Utils.Array.GetRandom(water);
      const a = Phaser.Math.FloatBetween(0, Math.PI * 2), s = Phaser.Math.FloatBetween(0.35, 0.6);
      const sprite = this.add.image(0, 0, 'fish_shadow').setOrigin(0.5).setAlpha(0.3).setDepth(-50);
      this.fishShadows.push({ gx: t.gx, gy: t.gy, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        turn: Phaser.Math.FloatBetween(2, 5), sprite });
    }
  }

  // lively water: a moving brightness wave + occasional ripple rings
  updateWater(dt) {
    if (!this.waterTiles || !this.waterTiles.length) return;
    const t = this.time.now * 0.001;
    for (const tile of this.waterTiles) {
      // low spatial frequency → a broad rolling shimmer across the whole pond, not per-tile flicker
      const w = 0.5 + 0.5 * Math.sin(t * 1.1 + tile.gx * 0.32 + tile.gy * 0.26);
      const f = 0.90 + 0.10 * w;                       // gentle brightness 0.90..1.00
      const base = tile.baseTint || 0xffffff;
      const r = Math.min(255, ((base >> 16) & 255) * f) | 0;
      const g = Math.min(255, ((base >> 8) & 255) * f) | 0;
      const b = Math.min(255, (base & 255) * f) | 0;
      tile.setTint((r << 16) | (g << 8) | b);
    }
    if (Math.random() < dt * 1.4) this.spawnRipple();
    if (this.fountainPos && Math.random() < dt * 7) this.spawnFountainDrop();
  }

  spawnFountainDrop() {
    const p = this.fountainPos;
    const drops = Math.random() < 0.4 ? 2 : 1;
    for (let i = 0; i < drops; i++) {
      const d = this.add.circle(p.x + Phaser.Math.Between(-4, 4), p.y - 14, Phaser.Math.FloatBetween(1.5, 2.5), 0xd6f1ff, 0.95).setDepth(99990);
      this.tweens.add({ targets: d, y: p.y - Phaser.Math.Between(28, 38), duration: Phaser.Math.Between(280, 360), yoyo: true, ease: 'Quad.out', onComplete: () => d.destroy() });
    }
  }

  spawnRipple() {
    const tile = Phaser.Utils.Array.GetRandom(this.waterTiles);
    if (!tile) return;
    const x = tile.x, y = tile.y, token = this.realmToken;
    const g = this.add.graphics().setDepth(-9000);
    this.tweens.addCounter({
      from: 2, to: 15, duration: 1500, ease: 'Quad.out',
      onUpdate: (tw) => {
        if (token !== this.realmToken) { g.clear(); return; }
        const v = tw.getValue();
        g.clear();
        g.lineStyle(1.5, 0xdff2ff, Math.max(0, 1 - v / 15));
        g.strokeEllipse(x, y, v * 2.4, v * 1.2);
      },
      onComplete: () => g.destroy(),
    });
  }

  updateFishShadows(dt) {
    if (!this.fishShadows) return;
    for (const fsh of this.fishShadows) {
      let nx = fsh.gx + fsh.vx * dt, ny = fsh.gy + fsh.vy * dt;
      if (!this.isWater(Math.round(nx), Math.round(ny))) {        // bounce off the shore
        fsh.vx *= -1; fsh.vy *= -1;
        nx = fsh.gx + fsh.vx * dt; ny = fsh.gy + fsh.vy * dt;
        if (!this.isWater(Math.round(nx), Math.round(ny))) { nx = fsh.gx; ny = fsh.gy; }
      }
      fsh.gx = nx; fsh.gy = ny;
      fsh.turn -= dt;
      if (fsh.turn <= 0) {                                        // wander
        fsh.turn = Phaser.Math.FloatBetween(2, 5);
        const a = Phaser.Math.FloatBetween(0, Math.PI * 2), s = Phaser.Math.FloatBetween(0.35, 0.6);
        fsh.vx = Math.cos(a) * s; fsh.vy = Math.sin(a) * s;
      }
      const sp = fsh.sprite;
      sp.setPosition(this.worldOX + isoX(fsh.gx, fsh.gy), this.worldOY + isoY(fsh.gx, fsh.gy));
      sp.setDepth(-50 + isoDepth(fsh.gx, fsh.gy) * 0.001);
      sp.setFlipX((fsh.vx - fsh.vy) < 0);
    }
  }

  // =========================================================================
  //  Combat — Sword vs Wilderness creepers (PvE) and Arena fighters (PvP)
  // =========================================================================
  spawnEnemies(cfg) {
    this.enemies = [];
    const conf = cfg.enemies || {};
    for (const kind in conf) for (let i = 0; i < conf[kind]; i++) this.spawnOneEnemy(kind, cfg);
    for (const [gx, gy] of (cfg.dummies || [])) this.createEnemy('dummy', gx, gy, cfg);  // fixed practice dummies
  }

  spawnOneEnemy(kind, cfg) {
    let gx, gy, tries = 0;
    const inArena = kind === 'fighter' && cfg.arena;
    do {
      if (inArena) {
        const a = Phaser.Math.FloatBetween(0, Math.PI * 2), r = Phaser.Math.FloatBetween(0, cfg.arena.r - 1);
        gx = Math.round(cfg.arena.cx + Math.cos(a) * r); gy = Math.round(cfg.arena.cy + Math.sin(a) * r);
      } else { gx = Phaser.Math.Between(2, GRID - 3); gy = Phaser.Math.Between(2, GRID - 3); }
    } while (!this.isWalkable(gx, gy) && tries++ < 40);
    this.createEnemy(kind, gx, gy, cfg);
  }

  createEnemy(kind, gx, gy, cfg) {
    const def = ENEMIES[kind];
    let sprite, outfit = null;
    const directional = kind === 'fighter';
    if (directional) {
      outfit = Phaser.Utils.Array.GetRandom(FIGHTERS);
      sprite = this.add.sprite(0, 0, 'axul', AXUL_ROW[outfit] * AXUL_COLS + AXUL_DIR_S)
        .setOrigin(0.5, 0.92).setScale(2.5).setInteractive({ useHandCursor: true });
      sprite.play(outfit + '_idle_' + AXUL_DIR_S);
    } else {
      sprite = this.add.image(0, 0, def.tex).setOrigin(0.5, 1).setScale(def.scale || 2.2).setInteractive({ useHandCursor: true });
    }
    const label = kind === 'fighter'
      ? this.add.text(0, 0, randomPlayerName(), { fontSize: '13px', color: '#ffd2d2', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 4 }).setOrigin(0.5, 1).setResolution(2)
      : null;
    const hpbar = this.add.graphics().setDepth(9000);
    const e = {
      kind, def, gx, gy, hp: def.hp, maxHp: def.hp, sprite, label, hpbar, dead: false,
      path: [], wait: Phaser.Math.FloatBetween(0, 2), attackCd: 0, home: { x: gx, y: gy },
      arena: kind === 'fighter' ? cfg.arena : null,
      directional, animSet: outfit, facingCol: AXUL_DIR_S,
    };
    sprite.on('pointerdown', (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.onEnemyClick(e); });
    this.enemies.push(e); this.placeEnemy(e);
    return e;
  }

  placeEnemy(e) {
    const x = this.worldOX + isoX(e.gx, e.gy), y = this.worldOY + isoY(e.gx, e.gy);
    e.sprite.setPosition(x, y + 6); e.sprite.setDepth(isoDepth(e.gx, e.gy) + 0.6);
    if (e.label) { e.label.setPosition(x, y - 40); e.label.setDepth(99999); }
    this.drawEnemyHp(e);
  }

  drawEnemyHp(e) {
    const g = e.hpbar; g.clear();
    if (e.hp >= e.maxHp && this.player.combatTarget !== e) return;     // only when hurt/engaged
    const x = this.worldOX + isoX(e.gx, e.gy) - 14, y = this.worldOY + isoY(e.gx, e.gy) - 52;
    g.fillStyle(0x10142b, 0.85); g.fillRect(x - 1, y - 1, 30, 5);
    g.fillStyle(0x3fbf55, 1); g.fillRect(x, y, 28 * Math.max(0, e.hp / e.maxHp), 3);
  }

  faceEntity(e, gx, gy) { this.faceDir(e, gx - e.gx, gy - e.gy); }

  stepToward(e, tx, ty, dt, speed) {
    const dx = tx - e.gx, dy = ty - e.gy, d = Math.hypot(dx, dy) || 1, step = speed * dt;
    const ngx = e.gx + (dx / d) * step, ngy = e.gy + (dy / d) * step;
    if (this.isWalkable(Math.round(ngx), Math.round(ngy)) ||
      (Math.round(ngx) === Math.round(tx) && Math.round(ngy) === Math.round(ty))) { e.gx = ngx; e.gy = ngy; }
    this.faceEntity(e, tx, ty);
  }

  enemyTarget(e) {
    const p = this.player;
    if (e.kind === 'creeper') {
      let best = (!p.dead && Math.hypot(p.gx - e.gx, p.gy - e.gy) <= e.def.aggro) ? p : null;
      let bd = best ? Math.hypot(p.gx - e.gx, p.gy - e.gy) : e.def.aggro;
      for (const b of (this.bots || [])) {              // also hunt the wilderness hunter NPCs
        if (!b.hunter) continue;
        const d = Math.hypot(b.gx - e.gx, b.gy - e.gy);
        if (d <= bd) { bd = d; best = b; }
      }
      return best;
    }
    // fighter: chase the player if they're attacking us, otherwise the nearest other fighter
    if (!p.dead && p.combatTarget === e && Math.hypot(p.gx - e.gx, p.gy - e.gy) <= 8) return p;
    let best = null, bd = e.def.aggro;
    for (const o of this.enemies) {
      if (o === e || o.dead || o.kind !== 'fighter') continue;
      const d = Math.hypot(o.gx - e.gx, o.gy - e.gy);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  updateEnemies(dt) {
    const p = this.player;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.def.static) { this.placeEnemy(e); continue; }   // practice dummies just stand there
      e.attackCd -= dt;
      const target = this.enemyTarget(e);
      if (target) {
        const d = Math.hypot(target.gx - e.gx, target.gy - e.gy);
        if (d > 1.3) { this.stepToward(e, target.gx, target.gy, dt, e.def.speed * 1.5); e.path = []; }
        else {
          this.faceEntity(e, target.gx, target.gy);
          if (e.attackCd <= 0) {
            e.attackCd = 1.2; this.enemySwing(e);
            if (target === p) this.damagePlayer(e.def.dmg);
            else if (target.def) this.damageEnemy(target, e.def.dmg, false);   // enemy vs enemy
            else this.flashSprite(target.sprite);                              // creeper swiping a hunter NPC (cosmetic, silent)
          }
        }
      } else if (e.path.length) { this.stepAlongPath(e, dt, e.def.speed); }
      else if (e.wait > 0) { e.wait -= dt; }
      else {
        const tx = Phaser.Math.Clamp(e.home.x + Phaser.Math.Between(-4, 4), 1, GRID - 2);
        const ty = Phaser.Math.Clamp(e.home.y + Phaser.Math.Between(-4, 4), 1, GRID - 2);
        const path = this.findPath(e.gx, e.gy, tx, ty);
        if (path && path.length) e.path = path; else e.wait = 1;
      }
      this.placeEnemy(e);
    }
  }

  enemySwing(e) { this.tweens.add({ targets: e.sprite, scaleX: 1.14, scaleY: 0.9, duration: 90, yoyo: true }); }
  flashSprite(s) { this.tweens.add({ targets: s, alpha: 0.4, duration: 70, yoyo: true }); }

  // --- player attacking enemies ---
  onEnemyClick(e) {
    if (this.player.equipped !== 'sword') { this.toast('Sword not equipped — press 4', 'warn'); return; }
    this.cancelGather(); this.cancelFishing();
    this.player.combatTarget = e;
    const stand = this.adjacentStand(e, this.player.gx, this.player.gy);
    if (stand) { const path = this.findPath(this.player.gx, this.player.gy, stand.x, stand.y); if (path) this.player.path = path; }
    this.pingMark(Math.round(e.gx), Math.round(e.gy));
  }

  handleCombat(dt) {
    const p = this.player, e = p.combatTarget;
    if (!e) return;
    if (e.dead || this.enemies.indexOf(e) < 0 || p.equipped !== 'sword' || p.dead) { this.clearCombat(); return; }
    const d = Math.hypot(e.gx - p.gx, e.gy - p.gy);
    if (d > 1.4) {                                   // chase the (moving) target
      this.stopSwordSwing();
      if (!p.path.length) {
        const stand = this.adjacentStand(e, p.gx, p.gy);
        if (stand) { const path = this.findPath(p.gx, p.gy, stand.x, stand.y); if (path) p.path = path; else this.stepToward(p, e.gx, e.gy, dt, MOVE_SPEED); }
        else this.stepToward(p, e.gx, e.gy, dt, MOVE_SPEED);
      }
      return;
    }
    p.path = [];
    this.faceEntity(p, e.gx, e.gy);
    if (!p.attackSwing) this.startSwordSwing();
    p.attackTimer += dt;
    if (p.attackTimer >= ATTACK_INTERVAL) {
      p.attackTimer = 0;
      const dmg = 3 + Math.floor(p.skills.combat.level / 3);
      this.damageEnemy(e, dmg, true);
    }
  }

  startSwordSwing() {
    if (this.player.swing) this.player.swing.stop();
    this.player.tool.setAngle(-45);
    this.player.attackSwing = this.tweens.add({
      targets: this.player.tool, angle: 50, duration: 200, yoyo: true, repeat: -1, ease: 'Sine.inOut',
    });
  }
  stopSwordSwing() {
    if (this.player.attackSwing) { this.player.attackSwing.stop(); this.player.attackSwing = null; }
    if (this.player.equipped === 'sword') this.player.tool.setAngle(0);
  }
  clearCombat() {
    if (!this.player) return;
    this.player.combatTarget = null; this.player.attackTimer = 0; this.stopSwordSwing();
  }

  damageEnemy(e, dmg, byPlayer) {
    if (e.dead) return;
    e.hp -= dmg;
    if (byPlayer) this.sfx('hit');                 // only the player's own hits are audible
    this.flashSprite(e.sprite);
    this.sparkBurst(e.sprite.x, e.sprite.y - 22, 4, [0xff8a8a, 0xffd0d0]);
    if (e.hp <= 0) this.killEnemy(e, byPlayer); else this.drawEnemyHp(e);
  }

  killEnemy(e, byPlayer) {
    e.dead = true;
    if (byPlayer) this.sfx('down');
    if (byPlayer && e.kind === 'creeper') this.learn('fight');   // tutorial completes on the KILL, not the first hit
    if (byPlayer) {
      let n = 0;
      for (const [item, qty] of e.def.loot()) if (qty > 0) {
        this.player.inv[item] += qty;
        this.floatGain(e.gx, e.gy - n * 0.4, qty, this.itemIconKey(item)); n++;   // stack the drop popups
      }
      this.addXP('combat', e.def.xp);
      this.refreshInventory(); this.saveProfile();
      if (e.kind !== 'dummy')        // dummies pop back up constantly — don't spam toasts
        this.toast(`Defeated ${e.kind === 'creeper' ? 'a Creeper' : e.label ? e.label.text : 'a fighter'}!`, 'level');
    }
    this.sparkBurst(e.sprite.x, e.sprite.y - 22, 8, [0xb9c0c8, 0xe6ebf2]);
    const s = e.sprite;
    this.tweens.add({ targets: s, alpha: 0, angle: 45, y: s.y + 6, duration: 380, onComplete: () => s.destroy() });
    if (e.label) e.label.destroy();
    e.hpbar.destroy();
    this.enemies = this.enemies.filter(x => x !== e);
    if (this.player.combatTarget === e) this.clearCombat();
    const token = this.realmToken, kind = e.kind, cfg = this.realmCfg, home = e.home;
    this.time.delayedCall(e.def.respawn, () => {
      if (token !== this.realmToken) return;
      if (e.def.static) this.createEnemy(kind, home.x, home.y, cfg);   // dummy reappears in place
      else this.spawnOneEnemy(kind, cfg);
    });
  }

  // dying in the Wilderness drops your whole backpack + the tools in your hotbar.
  // Only the Bank is safe — stash valuables before venturing out. Tools can be
  // re-collected from their stations (your tutorial progress is kept).
  dropCarriedItems() {
    const p = this.player;
    for (const k in p.inv) p.inv[k] = 0;                 // backpack: resources + loose coins
    for (const k in p.owned) p.owned[k] = false;         // hotbar: lose the tools
    for (const k in p.tools) p.tools[k] = 1;             // reset any tier upgrades
    p.equipped = '';
    this.updateToolSprite(); this.updateHotbar(); this.refreshInventory(); this.updateObjectives(); this.saveProfile();
  }

  // --- player vitals ---
  damagePlayer(dmg) {
    const p = this.player;
    if (p.dead || p.hurtCd > 0 || (this.cine && this.cine.on)) return;   // invulnerable during the cinematic tour
    p.hp -= dmg; p.hurtCd = 0.4; p.regenCd = 4;
    this.flashSprite(p.sprite);
    this.cameras.main.shake(110, 0.004);
    this.updateHealthHUD();
    if (p.hp <= 0) { p.hp = 0; this.playerDefeated(); }
  }

  updatePlayerVitals(dt) {
    const p = this.player;
    if (p.hurtCd > 0) p.hurtCd -= dt;
    if (p.regenCd > 0) p.regenCd -= dt;
    if (p.dead) return;
    const pl = this.realmCfg && this.realmCfg.plaza;
    let rate = 0;
    if (pl && Math.hypot(pl.cx - p.gx, pl.cy - p.gy) <= pl.r) rate = 10;   // healing plaza
    else if (p.regenCd <= 0 && !p.combatTarget) rate = 1.5;               // slow out-of-combat regen
    if (rate > 0 && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + rate * dt);
      this.updateHealthHUD();
      if (rate >= 10 && Math.random() < 0.08) this.sparkBurst(p.sprite.x, p.sprite.y - 26, 1, [0x6dffb0, 0xb0ffd0]);
    }
  }

  playerDefeated() {
    const p = this.player;
    p.dead = true; this.clearCombat(); this.player.path = [];
    const inWild = this.realm === 'wilderness';
    if (inWild) this.dropCarriedItems();           // the Wilderness is risky: lose everything you carried
    this.toast(inWild ? 'Slain in the Wilderness! You dropped everything you carried…' : 'You were defeated! Returning to Mainland…', 'warn');
    this.cameras.main.shake(220, 0.012);
    this.time.delayedCall(800, () => {
      p.hp = p.maxHp; p.dead = false; this.updateHealthHUD();
      if (this.realm !== 'mainland') { this.travelTo('mainland'); }
      else {
        const sp = REALMS.mainland.spawn; p.gx = sp.x; p.gy = sp.y; p.path = [];
        this.placeEntity(p); this.cameras.main.centerOn(p.sprite.x, p.sprite.y);
      }
    });
  }

  drawPlayerHp() {
    const g = this.playerHpBar; g.clear();
    const p = this.player;
    if (p.hp >= p.maxHp && !p.combatTarget) return;
    const x = p.sprite.x - 16, y = p.sprite.y - 52;
    g.fillStyle(0x10142b, 0.85); g.fillRect(x - 1, y - 1, 34, 6);
    g.fillStyle(0xe23b3b, 1); g.fillRect(x, y, 32 * Math.max(0, p.hp / p.maxHp), 4);
  }

  updateHealthHUD() {
    const v = document.getElementById('hp-val'); if (v) v.textContent = Math.ceil(this.player.hp) + '/' + this.player.maxHp;
    const f = document.getElementById('hp-fill'); if (f) f.style.width = (100 * this.player.hp / this.player.maxHp) + '%';
  }

  // =========================================================================
  //  Tools / skills / forge
  // =========================================================================
  equipTool(id) {
    if (!TOOLS[id]) return;
    if (!this.player.owned[id]) { this.toast(`Find the ${TOOLS[id].name} first!`, 'warn'); return; }
    if (this.player.equipped !== id) { this.cancelGather(); this.clearCombat(); }
    this.player.equipped = id;
    this.updateToolSprite();
    this.updateHotbar();
  }

  updateToolSprite() {
    const eq = this.player.equipped, own = this.player.owned[eq];
    this.player.tool.setVisible(!!own);
    if (own) this.player.tool.setTexture('tool_' + eq).setAngle(eq === 'rod' ? -8 : 18);
    this.placeEntity(this.player);
  }

  addXP(skill, amount) {
    const s = this.player.skills[skill];
    if (s.level >= SKILL_CAP) return;
    s.xp += amount;
    let leveled = false;
    while (s.level < SKILL_CAP && s.xp >= xpToNext(s.level)) {
      s.xp -= xpToNext(s.level); s.level++; leveled = true;
    }
    if (s.level >= SKILL_CAP) s.xp = 0;
    if (leveled) { this.toast(`${cap(skill)} Level ${s.level}!`, 'level'); this.sfx('level'); }
    this.updateSkills();
  }

  nearForge() {
    return this.forge &&
      Math.max(Math.abs(this.forge.gx - this.player.gx), Math.abs(this.forge.gy - this.player.gy)) <= 2.2;
  }

  upgradeEquipped() {
    const id = this.player.equipped, tier = this.player.tools[id];
    if (!UPGRADE_COST[id]) { this.toast(`${TOOLS[id].name} can't be upgraded`, 'warn'); return; }
    if (tier >= MAX_TIER) { this.toast(`${TOOLS[id].name} is max tier`, 'warn'); return; }
    const cost = UPGRADE_COST[id][tier + 1];
    for (const item in cost) if (this.player.inv[item] < cost[item]) {
      this.toast(`Need ${this.costString(cost)}`, 'warn'); return;
    }
    for (const item in cost) this.player.inv[item] -= cost[item];
    this.player.tools[id] = tier + 1;
    this.addXP('smithing', 40 * tier);
    this.toast(`${TOOLS[id].name} upgraded to Tier ${tier + 1}!`, 'level');
    this.refreshInventory(); this.updateHotbar(); this.updateToolSprite(); this.saveProfile();
  }

  costString(cost) {
    return Object.keys(cost).map(i => `${cost[i]} ${i}`).join(' + ');
  }

  updateInteractPrompt() {
    const el = document.getElementById('forge-prompt');
    if (this.modalOpen || this.dlgOpen) { el.style.display = 'none'; return; }
    if (this.nearForge()) {
      const id = this.player.equipped, tier = this.player.tools[id];
      el.style.display = 'block';
      if (tier >= MAX_TIER) el.innerHTML = `<b>${TOOLS[id].name}</b> is at max tier`;
      else {
        const cost = UPGRADE_COST[id][tier + 1];
        el.innerHTML = `Press <b>U</b> to upgrade <b>${TOOLS[id].name}</b> to Tier ${tier + 1}` +
          ` &nbsp;·&nbsp; cost <span class="cost">${this.costString(cost)}</span>`;
      }
      return;
    }
    el.style.display = 'none';
  }

  // ---- interactive buildings ------------------------------------------------
  placeBuildings(cfg) {
    this.buildings = []; this.buildingPortals = [];
    for (const b of (cfg.buildings || [])) {
      const span = b.small ? 0 : ((b.w && b.w >= 190) ? 2 : 1);   // base footprint = (span+1)^2
      const cx = b.gx + span / 2, cy = b.gy + span / 2;           // footprint centre
      const wx = this.worldOX + isoX(cx, cy), wy = this.worldOY + isoY(cx, cy);
      const dep = isoDepth(b.gx + span, b.gy + span);             // sort by the front-most tile
      let sprite;
      if (b.npc) {                                                // tool-station NPC (AxulArt char, anchored like the player)
        sprite = this.add.sprite(wx, wy + 6, 'axul', AXUL_ROW[b.npc] * AXUL_COLS + AXUL_DIR_S)
          .setOrigin(0.5, 0.92).setScale(2.5).setDepth(dep + 0.6).play(b.npc + '_idle_' + AXUL_DIR_S);
        for (const [ox, oy, tex, sc] of (b.decor || [])) {        // scattered lumber around the camp
          const lx = this.worldOX + isoX(b.gx + ox, b.gy + oy), ly = this.worldOY + isoY(b.gx + ox, b.gy + oy);
          const d = this.add.image(lx, ly + 4, tex).setOrigin(0.5, 0.82).setScale(sc || 1.4).setDepth(isoDepth(b.gx + ox, b.gy + oy) + 0.5);
          if (Math.random() < 0.5) d.setFlipX(true);
          this.structures.push({ type: 'decor', sprite: d, label: null });
        }
      } else if (b.anim) {
        sprite = this.add.sprite(wx, wy + 2, b.tex, 0).setOrigin(0.5, 0.9).setDepth(dep + 0.6).play(b.anim);
      } else {
        sprite = this.add.image(wx, wy + 2, b.tex).setOrigin(0.5, 0.9).setDepth(dep + 0.6);
      }
      if (b.scale) sprite.setScale(b.scale);
      else if (!b.small && !b.npc) sprite.setScale((b.w || 140) / sprite.width);
      sprite.setInteractive({ useHandCursor: true });            // click to interact (walks over if far)
      sprite.on('pointerdown', (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.onBuildingClick(b); });
      // block footprint + resource clearance
      this.reserve(b.gx, b.gy, b.npc ? 1 : span + 2, b.npc ? 1 : span + 2);
      if (b.npc) {                                                // keep the whole camp (npc + all its decor) free of trees/rocks
        let minx = b.gx, maxx = b.gx, miny = b.gy, maxy = b.gy;
        for (const [ox, oy] of (b.decor || [])) {
          minx = Math.min(minx, b.gx + ox); maxx = Math.max(maxx, b.gx + ox);
          miny = Math.min(miny, b.gy + oy); maxy = Math.max(maxy, b.gy + oy);
        }
        for (let gx = minx - 1; gx <= maxx + 1; gx++) for (let gy = miny - 1; gy <= maxy + 1; gy++) this.noSpawn.add(gx + ',' + gy);
      }
      // floating name label above; non-station buildings also get a circular icon badge
      const by = wy - (b.small || b.npc ? 70 : (sprite.displayHeight * 0.86 + 18));
      const tag = this.add.text(wx, by - 28, b.name, {
        fontSize: '22px', color: b.color || '#fff', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 5,
      }).setOrigin(0.5).setResolution(2).setDepth(99998);
      this.structures.push({ type: 'building', sprite, label: tag });
      if (!b.gives) {                                            // tool stations (camp/fisher) skip the floating tool icon
        const circ = this.add.circle(wx, by, 18, 0x12182f, 0.94).setStrokeStyle(3, 0x2c3566).setDepth(99997);
        const ico = this.add.image(wx, by, 'ic_' + b.icon).setDepth(99998);
        this.tweens.add({ targets: [circ, ico], y: '-=4', duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
        this.structures.push({ type: 'badge', sprite: circ, label: ico });
      }
      const bRec = { ...b, cx, cy, range: span + 2 };
      this.buildings.push(bRec);                                  // interaction radius scales with size
      // ground "entry" arrows: engraved tiles you step onto to enter (portal-style)
      if (b.entry) {
        const ents = Array.isArray(b.entry) ? b.entry : [b.entry];
        // one shared facing for every doorstep arrow so they stay parallel (not converging on the door)
        let cgx = 0, cgy = 0; for (const et of ents) { cgx += et.gx; cgy += et.gy; }
        cgx /= ents.length; cgy /= ents.length;
        const cex = this.worldOX + isoX(cgx, cgy), cey = this.worldOY + isoY(cgx, cgy);
        const arrowRot = Math.atan2(wy - cey, wx - cex) - Math.atan2(-1, 2);
        for (const et of ents) {
          const ex = this.worldOX + isoX(et.gx, et.gy), ey = this.worldOY + isoY(et.gx, et.gy);
          const dep = isoDepth(et.gx, et.gy);
          this.unmarkOccupied(et.gx, et.gy);                     // carve the doorstep out of the footprint so you can stand on it
          this.noSpawn.add(et.gx + ',' + et.gy);                 // keep trees/rocks off the doorstep
          const hi = this.add.image(ex, ey, 'tilehi').setOrigin(0.5).setTint(0x66ff7a).setAlpha(0).setDepth(dep + 0.1);
          const arrow = this.add.image(ex, ey, 'tilearrow').setOrigin(0.5).setDepth(dep + 0.2)
            .setRotation(arrowRot);                              // all arrows point the same way
          const bp = { b: bRec, to: b.entryTo, gx: et.gx, gy: et.gy, sprite: arrow, hi, armed: true, t: 0 };
          arrow.setInteractive({ useHandCursor: true });                           // click (when nearby) to walk in
          arrow.on('pointerdown', (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); this.onEntryArrowClick(bp); });
          this.structures.push({ type: 'portalarrow', sprite: arrow, label: hi });  // auto-destroyed on clearRealm
          this.buildingPortals.push(bp);
        }
      }
    }
    // training-ground dummies sit between the camp tiles — clear trees/rocks around them too
    for (const [gx, gy] of (cfg.dummies || []))
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.noSpawn.add((gx + dx) + ',' + (gy + dy));
  }

  nearestBuilding() {
    if (!this.buildings) return null;
    for (const b of this.buildings) {
      if (Math.max(Math.abs(b.cx - this.player.gx), Math.abs(b.cy - this.player.gy)) <= b.range) return b;
    }
    return null;
  }

  inRangeOf(b) { return Math.max(Math.abs(b.cx - this.player.gx), Math.abs(b.cy - this.player.gy)) <= b.range; }

  // building whose footprint (incl. the tile its sprite/body covers) contains a clicked tile
  buildingAtTile(gx, gy) {
    for (const b of (this.buildings || [])) {
      const span = (b.range || 2) - 2;     // up-left by 1 to cover the standing sprite's body
      if (gx >= b.gx - 1 && gx <= b.gx + span && gy >= b.gy - 1 && gy <= b.gy + span) return b;
    }
    return null;
  }

  onBuildingClick(b) {
    if (b.npc || this.inRangeOf(b)) { this.openBuilding(b); return; }   // NPCs talk instantly; no walk-over
    this.cancelGather(); this.cancelFishing(); this.clearCombat();
    this.moveTo(b.cx, b.cy, true);          // walk to it, then open on arrival
    this.pendingBuilding = b;
  }

  svgTag(key, size = 18) {
    return (ICON_SVG[key] || '').replace('<svg ', `<svg width="${size}" height="${size}" style="vertical-align:middle" `);
  }

  // ---- building UI: modal + panels + world map -----------------------------
  initBuildingUI() {
    const css = document.createElement('style');
    css.textContent = `
      #kmodal,#kworld{position:absolute;inset:0;z-index:50;display:none;align-items:center;justify-content:center;
        background:rgba(6,10,24,.66);backdrop-filter:blur(3px);}
      #kmodal.on,#kworld.on{display:flex;}
      .kcard{background:var(--panel);border:1px solid var(--panel-border);border-radius:16px;padding:18px 20px;
        min-width:320px;max-width:440px;box-shadow:0 18px 50px rgba(0,0,0,.5);}
      .kcard h2{font-size:18px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;}
      .kcard .sub{color:var(--muted);font-size:12px;margin-bottom:14px;}
      .krow{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;font-size:14px;border-top:1px solid #222b53;}
      .kbtn{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:8px;
        padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;}
      .kbtn.alt{background:#27305c;} .kbtn:hover{filter:brightness(1.1);} .kbtn:disabled{opacity:.4;cursor:default;}
      .kx{background:transparent;border:1px solid #44507f;color:#aab2dd;border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:14px;}
      .kcoins{color:#ffd76b;font-weight:700;} .kres{color:var(--good);font-weight:700;}
      .kmsg{margin-top:10px;font-size:13px;color:#cdd5ff;min-height:18px;text-align:center;}
      #kworld .kcard{max-width:none;} #kmapwrap{display:flex;gap:18px;align-items:flex-start;}
      #kmapcanvas{image-rendering:pixelated;border-radius:10px;border:1px solid #2c3566;background:#0b1024;}
      .klegend{min-width:180px;} .kleg{display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;}
      .kleg .b{width:22px;height:22px;border-radius:50%;background:#12182f;border:1px solid #2c3566;display:flex;align-items:center;justify-content:center;font-size:13px;}
      #kmap-btn{position:absolute;right:16px;top:84px;z-index:11;background:var(--panel);border:1px solid var(--panel-border);
        color:#dfe6ff;border-radius:10px;padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer;}
      .kcard{max-height:88vh;overflow-y:auto;overflow-x:hidden;}
      .kcard.wide{max-width:min(720px,94vw);}
      /* themed, slim scrollbars everywhere; never show a horizontal one */
      .kcard::-webkit-scrollbar,.kslots::-webkit-scrollbar,.klist::-webkit-scrollbar{width:10px;height:0;}
      .kcard::-webkit-scrollbar-thumb,.klist::-webkit-scrollbar-thumb{background:#2c3566;border-radius:8px;border:2px solid transparent;background-clip:content-box;}
      .kcard::-webkit-scrollbar-thumb:hover{background:#3a4680;background-clip:content-box;}
      .kcard,.klist{scrollbar-width:thin;scrollbar-color:#2c3566 transparent;}
      .ktabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;}
      .ktab{background:#1a2147;border:1px solid #2c3566;color:#aab2dd;border-radius:9px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;}
      .ktab.on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;}
      .ksec{background:#10142b;border:1px solid #222b53;border-radius:12px;padding:12px;margin-bottom:12px;}
      .ksec h4{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:10px;}
      .kslots{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;}
      .kslot{aspect-ratio:1;background:#1a2147;border:1px solid #2c3566;border-radius:10px;position:relative;display:flex;align-items:center;justify-content:center;}
      .kslot img{image-rendering:pixelated;} .kslot .cnt{position:absolute;top:2px;right:5px;font-size:12px;font-weight:800;color:#fff;text-shadow:0 1px 2px #000;}
      .ktrash{border:2px dashed #6a3030;border-radius:12px;padding:16px;text-align:center;color:#c98;background:rgba(120,40,40,.12);}
      .kgrid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;} .kgrid2>*{min-width:0;}
      .kskill{background:#10142b;border:1px solid #222b53;border-radius:12px;padding:12px;}
      .kskill .t{display:flex;align-items:center;gap:8px;font-weight:700;justify-content:space-between;}
      .kskill .nm{display:flex;align-items:center;gap:8px;} .kskill .lv{color:var(--good);font-weight:800;}
      .kskill .bar{height:8px;background:#1a2147;border-radius:5px;overflow:hidden;margin-top:8px;}
      .kskill .fill{height:100%;background:linear-gradient(90deg,#5ad860,#3aa84a);}
      .ktotal{background:#10142b;border:1px solid #222b53;border-radius:12px;padding:12px;text-align:center;font-weight:800;font-size:15px;}
      .ktoggle{display:flex;gap:10px;margin-bottom:12px;}
      .ktoggle button{flex:1;border:none;border-radius:10px;padding:11px;font-size:15px;font-weight:700;cursor:pointer;color:#fff;opacity:.5;}
      .ktoggle .sell{background:#b6403a;} .ktoggle .buy{background:#2f9e57;} .ktoggle button.on{opacity:1;}
      .kfilters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}
      .kfilters input,.kfilters select{background:#10142b;border:1px solid #2c3566;color:#dfe6ff;border-radius:8px;padding:8px 10px;font-size:13px;}
      .klist{display:flex;align-items:center;gap:10px;background:#10142b;border:1px solid #222b53;border-radius:10px;padding:10px 12px;margin-bottom:8px;}
      .klist .nm{flex:1;font-weight:600;} .klist .pr{color:#ffd76b;font-weight:800;display:flex;align-items:center;gap:5px;}
      .klist input{background:#0b1024;border:1px solid #2c3566;color:#dfe6ff;border-radius:7px;padding:6px 7px;font-size:13px;text-align:center;}
      .klist input:focus{outline:none;border-color:var(--accent2);}
      .kfield{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
      .ksellhint{color:var(--muted);font-size:12px;margin-bottom:10px;display:flex;gap:6px;align-items:center;}
      .kempty{background:#10142b;border:1px solid #222b53;border-radius:12px;padding:40px 12px;text-align:center;color:var(--muted);}
      .kslot.tool,.kslot.item{cursor:grab;} .kslot.on{border-color:var(--accent2);box-shadow:0 0 0 2px rgba(76,194,255,.45) inset;}
      .kslot.drophover{border-color:var(--good);} .ktrash.drophover{background:rgba(200,60,60,.28);}
      .kdrop{padding:6px;border-radius:10px;transition:outline .1s;} .kdrop.drophover{outline:2px dashed var(--good);outline-offset:-2px;background:rgba(159,255,203,.06);}
      /* Pixel-art RPG frame: assets/ui/dialog.png = Kenney RPG UI panel_brown (100x100, CC0).
         Slice 16 captures the frame; border width sets how thick it renders. */
      #kdlg{position:absolute;left:50%;bottom:104px;transform:translateX(-50%);z-index:40;display:none;width:min(560px,86vw);
        background:#7d5a32;                                   /* wood-brown fallback matching the panel */
        border:22px solid transparent;
        border-image:url(assets/ui/dialog.png) 16 fill stretch;
        image-rendering:pixelated;padding:8px 16px;
        box-shadow:0 16px 40px rgba(0,0,0,.55);cursor:pointer;}
      #kdlg .who{color:#ffd76a;font-weight:800;font-size:16px;margin-bottom:7px;letter-spacing:.5px;text-shadow:1px 1px 0 #000;}
      #kdlg .txt{font-size:15px;line-height:1.6;min-height:48px;color:#f3e9d2;text-shadow:1px 1px 0 rgba(0,0,0,.5);}
      #kdlg .choices{display:none;gap:10px;margin-top:14px;flex-wrap:wrap;}
      #kdlg .choices button{background:#7a4a22;color:#fff;border:2px solid #d9a05a;
        border-radius:4px;padding:9px 16px;font-size:14px;font-weight:700;cursor:pointer;text-shadow:1px 1px 0 #000;}
      #kdlg .choices button.no{background:#4a3526;border-color:#8a6a45;} #kdlg .choices button:hover{filter:brightness(1.15);}
    `;
    document.head.appendChild(css);
    const modal = document.createElement('div'); modal.id = 'kmodal'; modal.innerHTML = '<div class="kcard"></div>';
    document.body.appendChild(modal); this.modalEl = modal; this.modalCard = modal.querySelector('.kcard');
    modal.addEventListener('mousedown', e => { if (e.target === modal) this.closeModal(); });
    const world = document.createElement('div'); world.id = 'kworld'; world.innerHTML = '<div class="kcard"></div>';
    document.body.appendChild(world); this.worldEl = world; this.worldCard = world.querySelector('.kcard');
    world.addEventListener('mousedown', e => { if (e.target === world) this.toggleWorldMap(); });
    // story dialogue box (typewriter + choices)
    const dlg = document.createElement('div'); dlg.id = 'kdlg';
    dlg.innerHTML = '<div class="who"></div><div class="txt"></div><div class="choices"></div>';
    dlg.addEventListener('mousedown', () => { if (this.dlgTyping) this.dlgFinishTyping(); });
    document.body.appendChild(dlg); this.dlgEl = dlg;
    this.initHud();
  }

  // ---- RPG dialogue: word-by-word text + choices ----------------------------
  dialogue(who, text, choices) {
    const box = this.dlgEl; if (!box) return;
    this.dlgOpen = true; box.style.display = 'block';
    box.querySelector('.who').textContent = who;
    const txt = box.querySelector('.txt'); txt.textContent = '';
    const ch = box.querySelector('.choices'); ch.innerHTML = ''; ch.style.display = 'none';
    this.dlgChoices = choices; this.dlgFull = text;
    if (this.dlgTimer) this.dlgTimer.remove();
    const words = text.split(' '); let i = 0;
    this.dlgTyping = true;
    this.dlgTimer = this.time.addEvent({ delay: 55, loop: true, callback: () => {
      i++; txt.textContent = words.slice(0, i).join(' ');
      if (i >= words.length) this.dlgFinishTyping();
      else if (i % 2 === 0) this.sfx('talk');         // MMO-style text blip as it types
    } });
  }
  dlgFinishTyping() {
    if (this.dlgTimer) { this.dlgTimer.remove(); this.dlgTimer = null; }
    this.dlgTyping = false;
    const box = this.dlgEl; if (!box) return;
    box.querySelector('.txt').textContent = this.dlgFull;
    const ch = box.querySelector('.choices'); ch.innerHTML = ''; ch.style.display = 'flex';
    (this.dlgChoices || []).forEach((c, i) => {
      const b = document.createElement('button'); b.textContent = c.label;
      if (i > 0) b.className = 'no';
      b.onclick = (e) => { e.stopPropagation(); c.fn(); };
      ch.appendChild(b);
    });
  }
  closeDialogue() {
    this.dlgOpen = false; this.dlgTyping = false;
    if (this.dlgTimer) { this.dlgTimer.remove(); this.dlgTimer = null; }
    if (this.dlgEl) this.dlgEl.style.display = 'none';
  }

  // tutorial steps in order — a station only opens once every earlier step is done
  tutSteps() { return [['axe', 'chop'], ['rod', 'fish'], ['pickaxe', 'mine'], ['sword', 'fight']]; }
  stationLocked(id) {
    const steps = this.tutSteps(), idx = steps.findIndex(s => s[0] === id);
    if (idx <= 0) return null;                       // first (or unknown) station is always open
    const own = this.player.owned, learned = this.player.learned;
    for (let i = 0; i < idx; i++) { const [tool, act] = steps[i]; if (!own[tool] || !learned[act]) return steps[i]; }
    return null;
  }

  stationDialogue(b) {
    const id = b.gives, tool = TOOLS[id].name;
    const hint = { axe: 'Now go chop a tree in the forest!', rod: 'Now cast it on the pond to fish!', pickaxe: 'Now go mine a rock by the cave!', sword: 'Warm up on the dummies, then head to the Wilderness and slay a creeper!' }[id];
    const who = b.npcName || b.name;
    if (this.player.owned[id]) {
      this.dialogue(who, `You've already got the ${tool}, friend. ${hint}`, [{ label: 'See ya', fn: () => this.closeDialogue() }]);
      return;
    }
    const locked = this.stationLocked(id);           // gate behind earlier tutorial steps
    if (locked) {
      const [ptool, pact] = locked;
      const task = { chop: 'fell a tree', fish: 'catch a fish', mine: 'mine a rock', fight: 'slay a creeper in the Wilderness' }[pact];
      const msg = !this.player.owned[ptool]
        ? `Hold on, friend — you've skipped ahead. Go get the ${TOOLS[ptool].name} and learn the ropes first.`
        : `Not yet, friend. Come back once you've put that ${TOOLS[ptool].name} to use and ${task}.`;
      this.dialogue(who, msg, [{ label: 'Alright', fn: () => this.closeDialogue() }]);
      return;
    }
    this.dialogue(who, b.line, [
      { label: `Take the ${tool}`, fn: () => { this.grantTool(id); this.dialogue(who, hint, [{ label: 'Got it!', fn: () => this.closeDialogue() }]); } },
      { label: 'No thanks', fn: () => this.closeDialogue() },
    ]);
  }

  closeModal() { this.modalOpen = false; if (this.modalEl) this.modalEl.classList.remove('on'); }

  openByKey(key) {
    if (this.modalOpen || this.dlgOpen) return;
    ({ bank: () => this.panelBank(), merchant: () => this.panelMarket(),
       casino: () => this.panelCasino(), bonfire: () => this.panelBonfire() }[key] || (() => {}))();
  }

  openBuilding(b) {
    if (this.modalOpen || this.dlgOpen) return;
    if (b.gives) return this.stationDialogue(b);
    this.openByKey(b.key);
  }

  // ---- tutorial: tool stations + objectives ---------------------------------
  panelStation(b) {
    const tool = TOOLS[b.gives].name, have = this.player.owned[b.gives];
    const hint = { axe: 'Now go chop a tree!', rod: 'Now cast on the pond to fish!', pickaxe: 'Now mine a rock!', sword: 'Now head to the Wilderness and slay a creeper!' }[b.gives];
    const body = have
      ? `<div class="kempty">You already have the ${tool}. ${hint}</div>`
      : `<div class="ksellhint" style="margin-bottom:14px">${b.line || ''}</div>
         <button class="kbtn" id="ktake" style="width:100%;padding:11px;font-size:15px">Take the ${tool}</button>`;
    this.showPanel(b.name, '', body, card => {
      const t = card.querySelector('#ktake');
      if (t) t.onclick = () => { this.grantTool(b.gives); this.closeModal(); };
    });
  }

  grantTool(id) {
    if (this.player.owned[id]) return;
    this.player.owned[id] = true;
    this.equipTool(id);
    this.toast(`You got the ${TOOLS[id].name}!`, 'level');
    this.updateHotbar(); this.updateObjectives(); this.saveProfile();
  }

  learn(act) {
    if (!this.player.learned || this.player.learned[act]) return;
    this.player.learned[act] = true;
    this.updateObjectives(); this.saveProfile();
    if (!this.player.questDone && this.beginnerQuestComplete()) {
      this.player.questDone = true; this.saveProfile();
      this.time.delayedCall(700, () => this.showQuestGate());   // let the creeper-kill effects play first
    }
  }

  beginnerQuestComplete() {
    const own = this.player.owned, learned = this.player.learned;
    return ['axe', 'rod', 'pickaxe', 'sword'].every(t => own[t]) && ['chop', 'fish', 'mine', 'fight'].every(a => learned[a]);
  }

  // hard-gated quest-complete screen (pixel RPG frame): pick a username + connect a
  // wallet to continue. No close, no "keep playing" — connecting is the only way out.
  initQuestGate() {
    if (this.questGateEl) return;
    const css = document.createElement('style');
    css.textContent = `
      #questgate{position:fixed;inset:0;z-index:120;display:none;align-items:center;justify-content:center;
        background:rgba(6,10,24,.8);backdrop-filter:blur(3px);font-family:'Segoe UI',system-ui,sans-serif;}
      #questgate.on{display:flex;}
      #questgate .qg-box{width:min(450px,92vw);background:#7d5a32;border:26px solid transparent;
        border-image:url(assets/ui/dialog.png) 16 fill stretch;image-rendering:pixelated;padding:6px 18px 18px;text-align:center;}
      #questgate .qg-trophy{display:inline-block;image-rendering:pixelated;margin:4px 0 2px;filter:drop-shadow(0 3px 4px rgba(0,0,0,.5));}
      #questgate h3{display:inline-block;color:#fff6df;font-size:18px;font-weight:900;letter-spacing:.5px;line-height:1;
        margin:8px 0 10px;padding:11px 42px;image-rendering:pixelated;
        background:url(${this.texB64('ic_banner')}) center/100% 100% no-repeat;
        text-shadow:1px 1px 0 #5a1414,0 1px 2px rgba(0,0,0,.45);}
      #questgate p{color:#f3e9d2;font-size:13px;line-height:1.55;text-shadow:1px 1px 0 rgba(0,0,0,.45);margin:0;}
      #questgate .qg-sub{color:#e6d3a8;font-size:12.5px;margin-top:10px;}
      #questgate label{display:block;text-align:left;color:#ffd76a;font-weight:800;font-size:12px;margin:16px 0 6px;text-shadow:1px 1px 0 #000;letter-spacing:.5px;}
      #questgate input{width:100%;box-sizing:border-box;background:#2a1d12;border:2px solid #c9a05a;border-radius:6px;
        color:#fff;font-size:15px;padding:10px 12px;outline:none;}
      #questgate input:focus{border-color:#ffd76a;}
      #questgate .qg-avail{text-align:left;font-size:12px;margin-top:6px;min-height:16px;font-weight:700;text-shadow:1px 1px 0 rgba(0,0,0,.4);}
      #questgate .qg-avail.ok{color:#9fffcb;} #questgate .qg-avail.no{color:#ffb38a;}
      #questgate .qg-connect{margin-top:18px;width:100%;background:linear-gradient(135deg,#e0a93c,#c9852a);color:#3a2410;
        border:2px solid #ffd76a;border-radius:6px;padding:12px;font-size:15px;font-weight:900;cursor:pointer;letter-spacing:.5px;
        display:inline-flex;align-items:center;justify-content:center;gap:8px;}
      #questgate .qg-connect img{image-rendering:pixelated;}
      #questgate .qg-connect:hover{filter:brightness(1.08);}
      #questgate .qg-connect:disabled{filter:grayscale(.6) brightness(.85);cursor:default;}
    `;
    document.head.appendChild(css);
    const el = document.createElement('div'); el.id = 'questgate';
    el.innerHTML = `<div class="qg-box">
      <img class="qg-trophy" src="${this.texB64('ic_trophy')}" width="52" height="54" alt="">
      <h3>Beginner's Quest Complete!</h3>
      <p>You learned to <b>chop</b>, <b>fish</b>, <b>mine</b>, and <b>fight</b>. The world is yours now.</p>
      <p class="qg-sub">Pick your name and connect a wallet to <b>save your progress</b> and keep playing.</p>
      <label>Choose your username</label>
      <input id="qg-name" type="text" maxlength="16" placeholder="Enter a username" autocomplete="off" spellcheck="false">
      <div class="qg-avail" id="qg-avail"></div>
      <button class="qg-connect" id="qg-connect" disabled><img src="${this.texB64('ic_pouch')}" width="22" height="23" alt=""> Connect Wallet to Continue</button>
    </div>`;
    document.body.appendChild(el); this.questGateEl = el;
    const input = el.querySelector('#qg-name'), avail = el.querySelector('#qg-avail'), btn = el.querySelector('#qg-connect');
    // let the input receive keys Phaser captures for the game (WASD, 1-4, E, U, M, C, T): stop them reaching Phaser's window listener
    ['keydown', 'keyup', 'keypress'].forEach(ev => input.addEventListener(ev, e => e.stopPropagation()));
    const valid = () => input.value.trim().replace(/[^a-zA-Z0-9_]/g, '').length >= 3;
    input.addEventListener('input', () => {
      const name = input.value.trim();
      if (!name) { avail.textContent = ''; avail.className = 'qg-avail'; btn.disabled = true; }
      else if (!valid()) { avail.textContent = '✗ 3+ letters, numbers or _'; avail.className = 'qg-avail no'; btn.disabled = true; }
      else { avail.textContent = `✓ "${name}" is available`; avail.className = 'qg-avail ok'; btn.disabled = false; }
    });
    btn.addEventListener('click', () => {
      const name = input.value.trim(); if (!valid()) return;
      this.pendingUsername = name; this.questGateConnecting = true;
      const cb = document.getElementById('connect-btn'); if (cb) cb.click();   // success → onLogin migrates + closes the gate
    });
  }

  showQuestGate() {
    this.initQuestGate();
    this.modalOpen = true;                                   // freeze play behind the gate
    this.questGateEl.classList.add('on');
    const input = this.questGateEl.querySelector('#qg-name');
    if (input) setTimeout(() => input.focus(), 50);
    this.sfx('level');
  }

  closeQuestGate() {
    if (this.questGateEl) this.questGateEl.classList.remove('on');
    this.modalOpen = false;
    this.toast('Progress saved!', 'level');
  }

  // floating arrow pointing at the current objective's target (station, then nearest resource)
  currentGuideTarget() {
    const own = this.player.owned, learned = this.player.learned;
    if (!own || !learned) return null;
    const steps = [['axe', 'chop'], ['rod', 'fish'], ['pickaxe', 'mine'], ['sword', 'fight']];
    for (const [tool, act] of steps) {
      if (!own[tool]) { const b = (this.buildings || []).find(x => x.gives === tool); return b ? { gx: b.cx, gy: b.cy } : null; }
      if (!learned[act]) {
        // creepers live in the Wilderness — point at the danger gate until you've crossed over
        if (act === 'fight' && this.realm !== 'wilderness') return this.wildernessGateTarget();
        return this.nearestTargetFor(act);
      }
    }
    return null;
  }

  wildernessGateTarget() {
    let best = null, bd = 1e9;
    for (const p of (this.portals || [])) {
      if (p.to !== 'wilderness') continue;
      const d = Math.hypot(p.gx - this.player.gx, p.gy - this.player.gy);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { gx: best.gx, gy: best.gy } : null;
  }

  nearestTargetFor(act) {
    const near = list => {
      let best = null, bd = 1e9;
      for (const o of (list || [])) { if (o.dead) continue; const d = Math.hypot(o.gx - this.player.gx, o.gy - this.player.gy); if (d < bd) { bd = d; best = o; } }
      return best ? { gx: best.gx, gy: best.gy } : null;
    };
    if (act === 'fish') return near(this.waterTiles);
    if (act === 'fight') return near(this.enemies);
    const kinds = act === 'chop' ? ['tree'] : ['rock', 'coal'];
    return near((this.resources || []).filter(r => kinds.includes(r.kind)));
  }

  updateGuideArrow() {
    const a = this.guideArrow; if (!a) return;
    const tgt = this.modalOpen ? null : this.currentGuideTarget();
    if (!tgt || Math.hypot(tgt.gx - this.player.gx, tgt.gy - this.player.gy) < 2.2) { a.setVisible(false); return; }
    const px = this.worldOX + isoX(this.player.gx, this.player.gy), py = this.worldOY + isoY(this.player.gx, this.player.gy);
    const tx = this.worldOX + isoX(tgt.gx, tgt.gy), ty = this.worldOY + isoY(tgt.gx, tgt.gy);
    const ang = Math.atan2(ty - py, tx - px);
    const bob = Math.sin(this.time.now * 0.006) * 3;
    a.setVisible(true).setPosition(px + Math.cos(ang) * 34, py - 50 + bob + Math.sin(ang) * 34).setRotation(ang).setScale(1.4);
  }

  updateObjectives() {
    const el = document.getElementById('hud-objective');
    if (!el) return;
    const steps = [
      { tool: 'axe', act: 'chop', place: "Woodcutter's Camp", verb: 'chop a tree' },
      { tool: 'rod', act: 'fish', place: 'the Fisher by the pond', verb: 'catch a fish' },
      { tool: 'pickaxe', act: 'mine', place: 'the Cave', verb: 'mine a rock' },
      { tool: 'sword', act: 'fight', place: 'the Training Ground', verb: 'defeat a creeper in the Wilderness' },
    ];
    const own = this.player.owned, learned = this.player.learned;
    let cur = null;
    for (const s of steps) { if (!own[s.tool]) { cur = `Get the <b>${TOOLS[s.tool].name}</b> at <b>${s.place}</b>`; break; }
      if (!learned[s.act]) { cur = `Use your <b>${TOOLS[s.tool].name}</b> — ${s.verb}`; break; } }
    if (!cur) { el.style.display = 'none'; return; }
    const done = steps.filter(s => own[s.tool] && learned[s.act]).length;
    el.style.display = 'block';
    el.innerHTML = `<span class="ob-tag">Objective ${done + 1}/4</span> ${cur}`;
  }

  showPanel(title, sub, bodyHtml, wire, opts = {}) {
    this.modalOpen = true;
    this.modalCard.classList.toggle('wide', !!opts.wide);
    this.modalCard.innerHTML = `<h2><span>${title}</span><button class="kx">✕</button></h2>` +
      `<div class="sub">${sub || ''}</div>${bodyHtml}<div class="kmsg" id="kmsg"></div>`;
    this.modalCard.querySelector('.kx').addEventListener('click', () => this.closeModal());
    if (wire) wire(this.modalCard);
    this.modalEl.classList.add('on');
  }
  kmsg(t) { const m = document.getElementById('kmsg'); if (m) m.textContent = t; }

  // ---- redesigned HUD: circular minimap + compass + round action buttons ----
  initHud() {
    const MS = 132, MX = 44, MY = 62;                       // minimap size + top-left position
    const css = document.createElement('style');
    css.textContent = `
      #hud-mini{position:absolute;left:${MX}px;top:${MY}px;z-index:11;width:${MS}px;height:${MS}px;border-radius:50%;
        border:3px solid #2c3566;background:#0b1024;box-shadow:0 12px 30px rgba(0,0,0,.55);overflow:hidden;}
      #hud-mini canvas{width:100%;height:100%;display:block;image-rendering:pixelated;}
      #hud-compass{position:absolute;z-index:12;width:30px;height:30px;border-radius:50%;
        background:#edeff4;border:2px solid #2c3566;box-shadow:0 4px 12px rgba(0,0,0,.45);font-weight:800;color:#46506a;font-size:7px;}
      #hud-compass span{position:absolute;}
      #hud-compass .n{top:1px;left:50%;transform:translateX(-50%);color:#d24b4b}
      #hud-compass .s{bottom:1px;left:50%;transform:translateX(-50%)}
      #hud-compass .w{left:2px;top:50%;transform:translateY(-50%)}
      #hud-compass .e{right:2px;top:50%;transform:translateY(-50%)}
      #hud-compass .ndl{left:50%;top:50%;width:0;height:0;transform:translate(-50%,-100%);
        border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:11px solid #d24b4b}
      #hud-compass .sdl{left:50%;top:50%;width:0;height:0;transform:translate(-50%,0);
        border-left:4px solid transparent;border-right:4px solid transparent;border-top:11px solid #8b93a8}
      .hud-btn{position:absolute;z-index:11;width:46px;height:46px;border-radius:50%;background:var(--panel);border:1px solid var(--panel-border);
        cursor:pointer;display:flex;align-items:center;justify-content:center;color:#cfd6ff;box-shadow:0 6px 16px rgba(0,0,0,.45);}
      .hud-btn:hover{border-color:#4a559a;background:#1a2147;}
      #hud-objective{position:absolute;left:50%;top:52px;transform:translateX(-50%);z-index:12;display:none;
        background:var(--panel);border:1px solid var(--panel-border);border-radius:12px;padding:9px 16px;font-size:14px;
        color:var(--text);box-shadow:0 8px 22px rgba(0,0,0,.5);max-width:60vw;text-align:center;}
      #hud-objective .ob-tag{color:#ffd76b;font-weight:800;margin-right:8px;}
    `;
    document.head.appendChild(css);
    const obj = document.createElement('div'); obj.id = 'hud-objective'; document.body.appendChild(obj);
    const mini = document.createElement('div'); mini.id = 'hud-mini';
    const cv = document.createElement('canvas'); cv.width = MS; cv.height = MS; mini.appendChild(cv);
    document.body.appendChild(mini);
    mini.style.cursor = 'pointer'; mini.title = 'Open map (M)';
    mini.addEventListener('click', () => this.toggleWorldMap());   // click the minimap to open the full map
    this.miniCtx = cv.getContext('2d'); this.miniSize = MS;
    // compass at the circle's upper-left, half outside (top-down map => N is up)
    const comp = document.createElement('div'); comp.id = 'hud-compass';
    const cc = MX + MS / 2, ccy = MY + MS / 2, rr = MS / 2;
    comp.style.left = (cc + rr * Math.cos(Math.PI * 1.25) - 15) + 'px';
    comp.style.top = (ccy + rr * Math.sin(Math.PI * 1.25) - 15) + 'px';
    comp.innerHTML = '<span class="ndl"></span><span class="sdl"></span><span class="n">N</span><span class="s">S</span><span class="w">W</span><span class="e">E</span>';
    document.body.appendChild(comp);
    // four action buttons arranged in a downward arc below the minimap
    const defs = [['inventory', 'Items', () => this.panelInventory()], ['skills', 'Skills', () => this.panelSkills()],
      ['merchant', 'Market', () => this.panelMarket()], ['trophy', 'Arena', () => this.panelLeaderboard()]];
    const n = defs.length, step = 54, startX = MX + MS / 2 - (n - 1) * step / 2, baseY = MY + MS + 26;
    defs.forEach(([icon, label, fn], i) => {
      const b = document.createElement('button'); b.className = 'hud-btn';
      b.innerHTML = this.svgTag(icon, 22); b.title = label; b.onclick = fn;
      const t = (i - (n - 1) / 2) / ((n - 1) / 2);            // -1 .. 1 across the row
      b.style.left = (startX + i * step - 23) + 'px';
      b.style.top = (baseY + 16 * (1 - t * t) - 23) + 'px';   // gentle downward curve
      document.body.appendChild(b);
    });
    this.updateObjectives();
  }

  texB64(key) { return this.textures.exists(key) ? this.textures.getBase64(key) : ''; }
  itemImg(item, s = 30) {
    const m = { wood: 'ic_wood', stone: 'ic_stone', coal: 'ic_coal', fish: 'ic_fish' };
    if (m[item]) return `<img src="${this.texB64(m[item])}" width="${s}" height="${s}" style="image-rendering:pixelated">`;
    if (item === 'cookedfish') return this.svgTag('fish', s);
    if (item === 'coins') return this.svgTag('coin', s);
    return '';
  }
  toolImg(t, s = 28) { return `<img src="${this.texB64('tool_' + t)}" width="${s}" height="${s}" style="image-rendering:pixelated">`; }
  cap(w) { return w[0].toUpperCase() + w.slice(1); }
  itemName(it) { return it === 'coins' ? 'Gold' : it === 'cookedfish' ? 'Cooked Fish' : this.cap(it); }

  panelInventory(tab = 'items') {
    const inv = this.player.inv;
    const tabs = ['Items', 'Cosmetics', 'Mounts', 'Pets', 'Furni'];
    const tabsHtml = '<div class="ktabs">' + tabs.map(t =>
      `<button class="ktab ${t.toLowerCase() === tab ? 'on' : ''}" data-tab="${t.toLowerCase()}">${t}</button>`).join('') + '</div>';
    let body;
    if (tab !== 'items') {
      body = `<div class="kempty">${tabs.find(t => t.toLowerCase() === tab)} — coming soon.</div>`;
    } else {
      const hot = Array.from({ length: 6 }, (_, i) => {
        const t = TOOL_ORDER[i];
        return (t && this.player.owned[t]) ? `<div class="kslot tool ${this.player.equipped === t ? 'on' : ''}" draggable="true" data-tool="${t}" title="${TOOLS[t].name} — drag/click to equip">${this.toolImg(t, 30)}</div>`
          : '<div class="kslot"></div>';
      }).join('');
      const bag = [['wood', inv.wood], ['stone', inv.stone], ['coal', inv.coal], ['fish', inv.fish], ['cookedfish', inv.cookedfish], ['coins', inv.coins]].filter(([, v]) => v > 0);
      let cells = '';
      for (let i = 0; i < 24; i++) {
        const it = bag[i];
        cells += it ? `<div class="kslot item" draggable="true" data-item="${it[0]}">${this.itemImg(it[0], 30)}<span class="cnt">${it[1] > 999 ? '999+' : it[1]}</span></div>`
          : '<div class="kslot"></div>';
      }
      body = `<div class="ksec"><h4>Hotbar — drag a tool to equip</h4><div class="kslots">${hot}</div></div>
        <div class="ksec"><h4>Backpack</h4><div class="kslots">${cells}</div></div>
        <div class="ktrash" id="ktrash">Trash — drag here to destroy</div>`;
    }
    this.showPanel(this.svgTag('inventory', 20) + ' Inventory', '', tabsHtml + body, card => {
      card.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => this.panelInventory(b.dataset.tab));
      let drag = null;          // { kind:'tool'|'item', id }
      card.querySelectorAll('[data-tool]').forEach(el => {
        el.addEventListener('dragstart', () => drag = { kind: 'tool', id: el.dataset.tool });
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drophover'); });
        el.addEventListener('dragleave', () => el.classList.remove('drophover'));
        el.addEventListener('drop', e => { e.preventDefault(); if (drag && drag.kind === 'tool') { this.equipTool(drag.id); this.panelInventory('items'); } });
        el.addEventListener('click', () => { this.equipTool(el.dataset.tool); this.panelInventory('items'); });
      });
      card.querySelectorAll('[data-item]').forEach(el =>
        el.addEventListener('dragstart', () => drag = { kind: 'item', id: el.dataset.item }));
      const trash = card.querySelector('#ktrash');
      if (trash) {
        trash.addEventListener('dragover', e => { e.preventDefault(); trash.classList.add('drophover'); });
        trash.addEventListener('dragleave', () => trash.classList.remove('drophover'));
        trash.addEventListener('drop', e => {
          e.preventDefault();
          if (drag && drag.kind === 'item') {
            this.player.inv[drag.id] = 0; this.refreshInventory(); this.saveProfile();
            this.toast('Discarded ' + drag.id, 'warn'); this.panelInventory('items');
          }
        });
      }
    });
  }

  panelSkills() {
    const sk = this.player.skills, CAP = 30;
    const cook = `<img src="${this.texB64('ic_cooking')}" width="24" height="24">`;
    const rows = [['combat', 'Combat', this.toolImg('sword', 24)], ['woodcutting', 'Wood', this.toolImg('axe', 24)],
      ['mining', 'Mining', this.toolImg('pickaxe', 24)], ['fishing', 'Fishing', this.toolImg('rod', 24)],
      ['cooking', 'Cooking', cook], ['smithing', 'Smithing', this.svgTag('forge', 22)]];
    const grid = '<div class="kgrid2">' + rows.map(([k, n, ico]) => {
      const s = sk[k] || { level: 1, xp: 0 }, pct = s.level >= CAP ? 100 : Math.min(100, (s.xp / xpToNext(s.level)) * 100);
      return `<div class="kskill"><div class="t"><span class="nm">${ico}${n}</span><span class="lv">${s.level}/${CAP}</span></div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div></div>`;
    }).join('') + '</div>';
    const total = Object.values(sk).reduce((a, s) => a + s.level, 0);
    this.showPanel(this.svgTag('skills', 20) + ' Stats', '', grid + `<div class="ktotal">Total Level: ${total}</div>`);
  }

  panelLeaderboard(win = 'hourly') {
    const tabs = ['Hourly', 'Daily', 'Weekly', 'All-time'];
    const tabsHtml = '<div class="ktabs">' + tabs.map(t =>
      `<button class="ktab ${t.toLowerCase() === win ? 'on' : ''}" data-w="${t.toLowerCase()}">${t}</button>`).join('') + '</div>';
    this.showPanel(this.svgTag('trophy', 20) + ' Arena Leaderboard', '',
      tabsHtml + '<div class="kempty">No wins in this window yet.</div>', card => {
        card.querySelectorAll('[data-w]').forEach(b => b.onclick = () => this.panelLeaderboard(b.dataset.w));
      });
  }

  panelBank() {
    const inv = this.player.inv, bank = this.player.bank;
    const items = ['wood', 'stone', 'coal', 'fish', 'cookedfish', 'coins'];
    const banner = `<div style="display:flex;gap:12px;align-items:center;background:linear-gradient(135deg,#2a2f3a,#171b24);border:1px solid #4a5268;border-radius:12px;padding:10px 14px;margin-bottom:12px;">
      <img src="${this.texB64('vaultdoor')}" width="44" height="50" style="image-rendering:pixelated;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))">
      <div><div style="font-weight:800;color:#ffd76b;font-size:15px;">Vault Storage</div>
      <div style="color:#9fb3cc;font-size:12px;">Drag items between bag and vault. Only your vault survives death.</div></div></div>`;
    const grid = (store, from) => {
      const list = items.filter(it => (store[it] || 0) > 0);
      let cells = '';
      for (let i = 0; i < 12; i++) {
        const it = list[i];
        cells += it
          ? `<div class="kslot item" draggable="true" data-item="${it}" data-from="${from}" title="${this.itemName(it)} — drag to ${from === 'bag' ? 'vault to deposit' : 'bag to withdraw'}">${this.itemImg(it, 30)}<span class="cnt">${store[it] > 999 ? '999+' : store[it]}</span></div>`
          : '<div class="kslot"></div>';
      }
      return cells;
    };
    const body = banner + `<div class="kgrid2">
      <div class="ksec"><h4>Bag</h4><div class="kslots kdrop" id="kbag">${grid(inv, 'bag')}</div></div>
      <div class="ksec"><h4>${this.svgTag('bank', 14)} Vault</h4><div class="kslots kdrop" id="kvault">${grid(bank, 'bank')}</div></div>
    </div>`;
    this.showPanel(this.svgTag('bank', 20) + ' Bank', '', body, card => {
      const move = (it, fromStore, toStore) => { const n = fromStore[it] || 0; if (n <= 0) return;
        toStore[it] = (toStore[it] || 0) + n; fromStore[it] = 0;
        this.refreshInventory(); this.saveProfile(); this.panelBank(); };
      let drag = null;          // { id, from:'bag'|'bank' }
      card.querySelectorAll('[data-item]').forEach(el =>
        el.addEventListener('dragstart', () => drag = { id: el.dataset.item, from: el.dataset.from }));
      const wire = (zone, accept, doMove) => {
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drophover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drophover'));
        zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drophover'); if (drag && drag.from === accept) doMove(drag.id); });
      };
      wire(card.querySelector('#kvault'), 'bag', id => move(id, inv, bank));   // bag → vault = deposit
      wire(card.querySelector('#kbag'), 'bank', id => move(id, bank, inv));    // vault → bag = withdraw
    }, { wide: true });
  }

  seedMarket() {
    const its = ['wood', 'stone', 'coal', 'fish'], base = { wood: 1, stone: 2, coal: 3, fish: 2 };
    this.market = Array.from({ length: 12 }, (_, i) => {
      const it = Phaser.Utils.Array.GetRandom(its);
      return { id: 'm' + i, item: it, qty: Phaser.Math.Between(50, 23999), unit: base[it] + Phaser.Math.Between(0, 4), seller: randomPlayerName() };
    });
  }

  panelMarket(mode) {
    if (!this.market) this.seedMarket();
    if (!this.mkt) this.mkt = { mode: 'buy', sort: 'cheap', cat: 'all', q: '' };
    if (mode) this.mkt.mode = mode;
    const st = this.mkt, inv = this.player.inv, base = { wood: 1, stone: 2, coal: 3, fish: 2, cookedfish: 5 };
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const toggle = `<div class="ktoggle">
      <button class="sell ${st.mode === 'sell' ? 'on' : ''}" data-m="sell">Sell</button>
      <button class="buy ${st.mode === 'buy' ? 'on' : ''}" data-m="buy">Buy</button></div>
      <button class="kbtn alt" style="width:100%;margin-bottom:12px" data-m="mine">My Listings (${this.player.listings.length})</button>`;
    const filters = st.mode === 'buy' ? `<div class="kfilters">
      <input placeholder="Search items…" id="kmq" value="${st.q}">
      <select id="kmcat">${opt('all', st.cat, 'All categories')}${['wood', 'stone', 'coal', 'fish'].map(c => opt(c, st.cat, this.cap(c))).join('')}</select>
      <select id="kmsort">${opt('cheap', st.sort, 'Cheapest')}${opt('pricey', st.sort, 'Priciest')}</select>
      <select><option>Gold</option></select></div>` : '';
    const row = (l, action) => `<div class="klist">${this.itemImg(l.item, 28)}
      <span class="nm">${this.itemName(l.item)}×${l.qty} — ${l.seller}</span>${action}</div>`;
    let body;
    if (st.mode === 'mine') {
      body = this.player.listings.length
        ? this.player.listings.map(l => row(l, `<button class="kbtn alt" data-cancel="${l.id}">Cancel</button>`)).join('')
        : '<div class="kempty">You have no active listings.</div>';
    } else if (st.mode === 'buy') {
      let rows = [...this.market, ...this.player.listings.map(l => ({ ...l, mine: true }))];
      if (st.cat !== 'all') rows = rows.filter(l => l.item === st.cat);
      if (st.q) rows = rows.filter(l => l.item.includes(st.q.toLowerCase()));
      rows.sort((a, b) => st.sort === 'cheap' ? a.unit - b.unit : b.unit - a.unit);
      body = rows.length ? rows.map(l => row(l, l.mine
        ? `<span class="pr">${this.svgTag('coin', 15)} ${l.unit} <em style="color:var(--muted);font-style:normal">(you)</em></span>`
        : `<button class="kbtn" data-buy="${l.id}">${this.svgTag('coin', 14)} ${l.unit}</button>`)).join('')
        : '<div class="kempty">No listings match.</div>';
    } else { // sell — choose quantity + price (gold per unit) per item
      const sellable = ['wood', 'stone', 'coal', 'fish', 'cookedfish'];
      body = `<div class="ksellhint">Set quantity and price (${this.svgTag('coin', 13)} gold each), then List.</div>` +
        sellable.map(it => {
          const have = inv[it] || 0, dis = have ? '' : 'disabled';
          return `<div class="klist">${this.itemImg(it, 28)}
            <span class="nm">${this.itemName(it)} <em style="color:var(--muted);font-style:normal">(${have})</em></span>
            <label class="kfield">Qty<input id="kq_${it}" type="text" inputmode="numeric" value="${Math.min(have, 10) || 1}" style="width:60px" ${dis}></label>
            <label class="kfield">Gold ea<input id="kp_${it}" type="text" inputmode="numeric" value="${base[it]}" style="width:56px" ${dis}></label>
            <button class="kbtn" data-list="${it}" ${dis}>List</button></div>`;
        }).join('');
    }
    this.showPanel(this.svgTag('merchant', 20) + ' Marketplace', 'List items for gold.',
      toggle + filters + body, card => {
        card.querySelectorAll('[data-m]').forEach(b => b.onclick = () => this.panelMarket(b.dataset.m));
        const q = card.querySelector('#kmq'); if (q) q.onchange = () => { st.q = q.value.trim().toLowerCase(); this.panelMarket(); };
        const cat = card.querySelector('#kmcat'); if (cat) cat.onchange = () => { st.cat = cat.value; this.panelMarket(); };
        const sort = card.querySelector('#kmsort'); if (sort) sort.onchange = () => { st.sort = sort.value; this.panelMarket(); };
        card.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => {
          const l = this.market.find(x => x.id === b.dataset.buy); if (!l) return;
          const cost = l.unit * l.qty;
          if (inv.coins < cost) { this.kmsg(`Need ${cost} gold (you have ${inv.coins}).`); return; }
          inv.coins -= cost; inv[l.item] = (inv[l.item] || 0) + l.qty;
          this.market = this.market.filter(x => x !== l);
          this.toast(`Bought ${l.qty} ${l.item} for ${cost} gold`, 'level');
          this.refreshInventory(); this.saveProfile(); this.panelMarket();
        });
        card.querySelectorAll('[data-list]').forEach(b => b.onclick = () => {
          const it = b.dataset.list, have = inv[it] || 0;
          const qty = Math.min(have, Math.max(1, parseInt(card.querySelector('#kq_' + it).value, 10) || 0));
          const unit = Math.max(1, parseInt(card.querySelector('#kp_' + it).value, 10) || 0);
          if (have <= 0 || qty <= 0) { this.kmsg('Nothing to list.'); return; }
          this.player.listings.push({ id: 'u' + Date.now() + it, item: it, qty, unit, seller: this.player.label.text || 'You' });
          inv[it] -= qty; this.toast(`Listed ${qty} ${it} @ ${unit}g`, 'level');
          this.refreshInventory(); this.saveProfile(); this.panelMarket('mine');
        });
        card.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => {
          const i = this.player.listings.findIndex(x => x.id === b.dataset.cancel); if (i < 0) return;
          const l = this.player.listings[i]; inv[l.item] = (inv[l.item] || 0) + l.qty;
          this.player.listings.splice(i, 1); this.toast(`Unlisted ${l.item}`); this.refreshInventory(); this.saveProfile(); this.panelMarket('mine');
        });
      });
  }

  panelCasino() {
    const inv = this.player.inv;
    const body = [10, 50, 100].map(bet => `<div class="krow"><span>Bet <b class="kcoins">${bet} ${this.svgTag('coin', 13)}</b> · 45% to double</span>
      <button class="kbtn" data-bet="${bet}">Spin</button></div>`).join('');
    this.showPanel(this.svgTag('casino', 20) + ' Casino', `Coins: <b class="kcoins">${inv.coins}</b>`, body, card => {
      card.querySelectorAll('[data-bet]').forEach(btn => btn.onclick = () => {
        const bet = +btn.dataset.bet;
        if (inv.coins < bet) { this.kmsg('Not enough coins.'); return; }
        inv.coins -= bet;
        if (Math.random() < 0.45) { inv.coins += bet * 2; this.kmsg(`You won ${bet} coins!`); }
        else this.kmsg(`You lost ${bet} coins.`);
        this.refreshInventory(); this.saveProfile();
        document.querySelector('#kmodal .sub').innerHTML = `Coins: <b class="kcoins">${inv.coins}</b>`;
      });
    });
  }

  panelBonfire() {
    const inv = this.player.inv;
    const body = `<div class="krow"><span>Raw fish <b class="kres">${inv.fish}</b></span>
        <button class="kbtn" id="kcook">Cook All</button></div>
      <div class="krow"><span>Cooked fish <b class="kres">${inv.cookedfish}</b> · heals 8 HP</span>
        <button class="kbtn alt" id="keat">Eat one</button></div>`;
    this.showPanel(this.svgTag('cooking', 20) + ' Cooking Fire', 'Cook your catch, then eat to heal.', body, card => {
      card.querySelector('#kcook').onclick = () => {
        if (inv.fish <= 0) { this.kmsg('No raw fish.'); return; }
        const n = inv.fish; inv.cookedfish += n; inv.fish = 0;
        this.addXP('cooking', n * 3); this.toast(`Cooked ${n} fish`, 'level');
        this.refreshInventory(); this.saveProfile(); this.panelBonfire();
      };
      card.querySelector('#keat').onclick = () => {
        if (inv.cookedfish <= 0) { this.kmsg('No cooked fish.'); return; }
        if (this.player.hp >= this.player.maxHp) { this.kmsg('Already full HP.'); return; }
        inv.cookedfish -= 1; this.player.hp = Math.min(this.player.maxHp, this.player.hp + 8);
        this.updateHealthHUD(); this.refreshInventory(); this.saveProfile(); this.panelBonfire();
      };
    });
  }

  toggleWorldMap() {
    if (!this.worldEl) return;
    if (this.worldEl.classList.contains('on')) { this.worldEl.classList.remove('on'); return; }
    this.renderWorldMap(); this.worldEl.classList.add('on');
  }

  // best texture key for a POI's map/legend icon (camps reuse tool icons; training = archer target)
  poiIcon(b) {
    if (b.icon && this.textures.exists('ic_' + b.icon)) return 'ic_' + b.icon;
    return { woodcamp: 'tool_axe', fishcamp: 'tool_rod', minecamp: 'tool_pickaxe', traincamp: 'target' }[b.key] || null;
  }
  // draw a generated Phaser texture onto a 2D canvas (synchronous — source is a canvas)
  drawTex(ctx, key, cx, cy, size) {
    if (!key || !this.textures.exists(key)) return;
    ctx.drawImage(this.textures.get(key).getSourceImage(), Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
  }
  // big translucent area names over the map (FOREST / MINES / POND / ARENA / TOWN)
  drawRegionLabels(ctx, S) {
    const cfg = this.realmCfg, labels = [];
    if (cfg.treeArea) labels.push([cfg.treeArea.cx, cfg.treeArea.cy, 'FOREST']);
    if (cfg.rockArea) labels.push([cfg.rockArea.cx, cfg.rockArea.cy, 'MINES']);
    if (this.waterTiles && this.waterTiles.length) {
      let sx = 0, sy = 0; for (const t of this.waterTiles) { sx += t.gx; sy += t.gy; }
      labels.push([sx / this.waterTiles.length, sy / this.waterTiles.length, 'POND']);
    }
    if (cfg.arena) labels.push([cfg.arena.cx, cfg.arena.cy, 'ARENA']);
    if (cfg.plaza) labels.push([cfg.plaza.cx, cfg.plaza.cy, 'TOWN']);
    ctx.save();
    ctx.font = '800 21px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    for (const [gx, gy, t] of labels) {
      const x = gx * S + S / 2, y = gy * S + S / 2;
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillText(t, x + 1, y + 1);
      ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText(t, x, y);
    }
    ctx.restore();
  }

  renderWorldMap() {
    const S = 9, W = GRID * S;
    const legImg = key => (key && this.textures.exists(key)) ? `<img src="${this.texB64(key)}" width="17" height="17">` : '';
    const legRow = (key, name, color) => `<div class="kleg"><span class="b" style="border-color:${color}">${legImg(key)}</span>${name}</div>`;
    const legend = (this.realmCfg.buildings || []).map(b => legRow(this.poiIcon(b), b.name, b.color || '#2c3566')).join('') +
      legRow('forge', 'Forge', '#ffd07a') + legRow('tool_sword', 'PvP Arena', '#ff7a7a');
    this.worldCard.innerHTML = `<h2><span>${this.svgTag('map', 20)} World Map · ${this.realmCfg.name}</span><button class="kx">✕</button></h2>
      <div id="kmapwrap"><canvas id="kmapcanvas" width="${W}" height="${W}"></canvas>
      <div class="klegend"><div class="sub">Legend</div>${legend}</div></div>`;
    this.worldCard.querySelector('.kx').onclick = () => this.toggleWorldMap();
    const ctx = this.worldCard.querySelector('#kmapcanvas').getContext('2d');
    for (const t of this.tiles) {                       // top-down terrain
      ctx.fillStyle = t.water ? '#3f8fd0' : '#3f8a4a';
      ctx.fillRect(t.gx * S, t.gy * S, S, S);
    }
    ctx.fillStyle = 'rgba(74,58,40,.6)';                 // resources as faint specks (forest/mines texture)
    for (const r of (this.resources || [])) ctx.fillRect(r.gx * S + 2, r.gy * S + 2, S - 4, S - 4);
    this.drawRegionLabels(ctx, S);
    // POI markers: disc + icon + name label
    const poi = (gx, gy, key, name, color) => {
      const cx = gx * S + S / 2, cy = gy * S + S / 2;
      ctx.fillStyle = 'rgba(10,14,30,.88)'; ctx.beginPath(); ctx.arc(cx, cy, 11, 0, 7); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
      this.drawTex(ctx, key, cx, cy, 16);
      ctx.font = '700 11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(name, cx + 1, cy + 23);
      ctx.fillStyle = '#e8ecff'; ctx.fillText(name, cx, cy + 22);
    };
    for (const b of (this.realmCfg.buildings || [])) poi(b.gx, b.gy, this.poiIcon(b), b.name, b.color || '#9fffcb');
    if (this.forge) poi(Math.round(this.forge.gx), Math.round(this.forge.gy), 'forge', 'Forge', '#ffd07a');
    if (this.realmCfg.arena) poi(this.realmCfg.arena.cx, this.realmCfg.arena.cy, 'tool_sword', 'PvP Arena', '#ff7a7a');
    // one marker per gate (the strip spans many portal tiles): skull for danger, disc for safe
    const cen = arr => arr.reduce((a, p) => ({ gx: a.gx + p.gx / arr.length, gy: a.gy + p.gy / arr.length }), { gx: 0, gy: 0 });
    const dangerP = (this.portals || []).filter(p => p.danger), safeP = (this.portals || []).filter(p => !p.danger);
    if (dangerP.length) {
      const c = cen(dangerP), cx = c.gx * S + S / 2, cy = c.gy * S + S / 2;
      ctx.fillStyle = 'rgba(10,14,30,.9)'; ctx.beginPath(); ctx.arc(cx, cy, 15, 0, 7); ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff6a6a'; ctx.stroke();
      this.drawTex(ctx, 'ic_skull', cx, cy, 24);
      ctx.font = '700 11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText('Danger Zone', cx + 1, cy + 27);
      ctx.fillStyle = '#ffb3a0'; ctx.fillText('Danger Zone', cx, cy + 26);
    }
    if (safeP.length) { const c = cen(safeP); poi(c.gx, c.gy, null, 'Safe Zone', '#7fff9e'); }
    // player position — gold "YOU" badge
    const px = this.player.gx * S + S / 2, py = this.player.gy * S + S / 2;
    ctx.fillStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(px, py, 12, 0, 7); ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#2a1a52'; ctx.stroke();
    ctx.font = '800 10px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2a1a52'; ctx.fillText('YOU', px, py + 0.5);
    ctx.textBaseline = 'alphabetic';
  }

  // =========================================================================
  //  Update loop
  // =========================================================================
  update(time, delta) {
    const dt = Math.min(delta / 1000, 0.05);
    this.handleKeyboardMove(dt);
    this.handlePlayerMove(dt);
    this.handleGatherLoop(dt);
    this.handleFishing(dt);
    this.handleCombat(dt);
    this.updateBots(dt);
    this.updateEnemies(dt);
    this.updatePlayerVitals(dt);
    this.updateDirAnim(this.player);
    if (this.bots) for (const b of this.bots) this.updateDirAnim(b);
    if (this.enemies) for (const e of this.enemies) this.updateDirAnim(e);
    this.updateFishShadows(dt);
    this.updateWater(dt);
    this.updatePortals(dt);
    this.updateBuildingPortals(dt);
    if (Phaser.Input.Keyboard.JustDown(this.keys.T) && !this.modalOpen && !this.dlgOpen) this.toggleCinematic();   // T disabled while a panel/gate is open
    if (this.cine && this.cine.on) return;                           // director mode: freeze player input + HUD, let the camera tour
    this.drawPlayerHp();
    if (this.modalOpen || this.dlgOpen) return;                      // a panel/quest gate is open — freeze hotkeys
    if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) this.equipTool('axe');
    if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) this.equipTool('pickaxe');
    if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) this.equipTool('rod');
    if (Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) this.equipTool('sword');
    if (Phaser.Input.Keyboard.JustDown(this.keys.U)) this.upgradeEquipped();
    if (Phaser.Input.Keyboard.JustDown(this.keys.E)) { const b = this.nearestBuilding(); if (b) this.openBuilding(b); }
    if (Phaser.Input.Keyboard.JustDown(this.keys.M)) this.toggleWorldMap();
    if (Phaser.Input.Keyboard.JustDown(this.keys.C)) this.recenterCamera();
    if (Phaser.Input.Keyboard.JustDown(this.keyZoomIn)) this.zoomBy(0.15);
    if (Phaser.Input.Keyboard.JustDown(this.keyZoomOut)) this.zoomBy(-0.15);
    this.updateInteractPrompt();
    this.updateGuideArrow();
    if (this.pendingBuilding) {              // clicked a building from afar -> open when we arrive
      if (this.inRangeOf(this.pendingBuilding)) { const b = this.pendingBuilding; this.pendingBuilding = null; this.openBuilding(b); }
      else if (!this.player.path.length) this.pendingBuilding = null;
    }
    this.drawMinimap();
  }

  handleKeyboardMove(dt) {
    if (this.modalOpen || this.dlgOpen) return;            // frozen while a panel/gate is open
    const k = this.keys; let mx = 0, my = 0;
    if (k.W.isDown || k.UP.isDown) { mx -= 1; my -= 1; }
    if (k.S.isDown || k.DOWN.isDown) { mx += 1; my += 1; }
    if (k.A.isDown || k.LEFT.isDown) { mx -= 1; my += 1; }
    if (k.D.isDown || k.RIGHT.isDown) { mx += 1; my -= 1; }
    if (!mx && !my) return;
    this.cancelGather(); this.cancelFishing(); this.clearCombat(); this.player.path = [];   // manual move overrides
    const len = Math.hypot(mx, my), step = MOVE_SPEED * dt;
    let ngx = Phaser.Math.Clamp(this.player.gx + (mx / len) * step, 0, GRID - 1);
    let ngy = Phaser.Math.Clamp(this.player.gy + (my / len) * step, 0, GRID - 1);
    if (this.isWalkable(Math.round(ngx), Math.round(ngy))) {
      this.faceDir(this.player, mx, my);
      this.player.gx = ngx; this.player.gy = ngy;
    }
  }

  handlePlayerMove(dt) {
    if (this.player.path.length) this.stepAlongPath(this.player, dt, MOVE_SPEED);
    this.placeEntity(this.player);
  }

  handleGatherLoop(dt) {
    const node = this.player.gatherTarget;
    if (!node) return;
    if (node._gone || node.amount <= 0) { this.cancelGather(); return; }   // felled by an NPC mid-chop
    if (this.player.path.length) return;                 // still walking to it
    if (!this.adjacentToNode(node)) { this.cancelGather(); return; }
    if (this.player.equipped !== NODES[node.kind].tool) { this.cancelGather(); return; }
    if (!this.player.swing) this.startGather();          // arrived: begin
    this.player.gatherTimer += dt;
    if (this.player.gatherTimer >= this.player.gatherDur) this.finishGatherTick();
  }

  floatText(gx, gy, msg) {
    const t = this.add.text(this.worldOX + isoX(gx, gy), this.worldOY + isoY(gx, gy) - 28, msg, {
      fontSize: '14px', color: '#9fffcb', fontStyle: 'bold', stroke: '#10142b', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(99999);
    this.tweens.add({ targets: t, y: t.y - 26, alpha: 0, duration: 800, onComplete: () => t.destroy() });
  }

  // =========================================================================
  //  Minimap
  // =========================================================================
  buildMinimap() { /* circular DOM minimap is created in initHud(); drawMinimap renders it */ }

  drawMinimap() {
    const ctx = this.miniCtx; if (!ctx || !this.tiles) return;
    const S = this.miniSize / GRID, tk = BIOMES[this.realmCfg.biome];
    const hex = n => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
    ctx.fillStyle = hex(tk.mmLand); ctx.fillRect(0, 0, this.miniSize, this.miniSize);
    ctx.fillStyle = hex(tk.mmWater);
    for (const t of this.tiles) if (t.water) ctx.fillRect(t.gx * S, t.gy * S, Math.ceil(S), Math.ceil(S));
    // POI icons only — no NPC/resource dots
    const ic = (gx, gy, key, sz = 11) => this.drawTex(ctx, key, gx * S, gy * S, sz);
    for (const b of (this.buildings || [])) ic(b.cx, b.cy, this.poiIcon(b));
    if (this.forge) ic(this.forge.gx, this.forge.gy, 'forge');
    if (this.realmCfg.arena) ic(this.realmCfg.arena.cx, this.realmCfg.arena.cy, 'tool_sword');
    // one gate marker (strip spans many tiles): skull for danger, dot for safe
    const cen = arr => arr.reduce((a, p) => ({ gx: a.gx + p.gx / arr.length, gy: a.gy + p.gy / arr.length }), { gx: 0, gy: 0 });
    const dP = (this.portals || []).filter(p => p.danger), sP = (this.portals || []).filter(p => !p.danger);
    if (dP.length) { const c = cen(dP); this.drawTex(ctx, 'ic_skull', c.gx * S, c.gy * S, 17); }
    if (sP.length) { const c = cen(sP); ctx.fillStyle = '#7fff9e'; ctx.beginPath(); ctx.arc(c.gx * S, c.gy * S, 2.8, 0, 7); ctx.fill(); }
    // player marker
    ctx.fillStyle = '#4cc2ff'; ctx.beginPath(); ctx.arc(this.player.gx * S, this.player.gy * S, 3.2, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(76,194,255,.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(this.player.gx * S, this.player.gy * S, 5.5, 0, 7); ctx.stroke();
  }

  // =========================================================================
  //  Profiles / saves  (the only thing wallet identity touches)
  // =========================================================================
  loadProfile(label, saveKey) {
    this.player.saveKey = saveKey;
    this.player.label.setText(label);
    let d = null;
    const raw = localStorage.getItem('kintara_save_' + saveKey);
    if (raw) { try { d = JSON.parse(raw); } catch (_) { d = null; } }

    // stats
    const freshSkills = () => ({ woodcutting: { level: 1, xp: 0 }, mining: { level: 1, xp: 0 }, fishing: { level: 1, xp: 0 }, combat: { level: 1, xp: 0 }, cooking: { level: 1, xp: 0 }, smithing: { level: 1, xp: 0 } });
    const freshInv = () => ({ wood: 0, stone: 0, coal: 0, fish: 0, cookedfish: 0, coins: 0 });
    if (d) {
      this.player.inv = Object.assign(freshInv(), d.inv || {});
      this.player.tools = Object.assign({ axe: 1, pickaxe: 1, rod: 1, sword: 1 }, d.tools || {});
      this.player.skills = Object.assign(freshSkills(), d.skills || {});
      this.player.bank = Object.assign(freshInv(), d.bank || {});
      this.player.listings = Array.isArray(d.listings) ? d.listings : [];
      // existing players keep all tools; new saves track what's been collected
      this.player.owned = Object.assign({ axe: true, pickaxe: true, rod: true, sword: true }, d.owned || {});
      this.player.learned = Object.assign({ chop: true, fish: true, mine: true, fight: true }, d.learned || {});
    } else {
      this.player.inv = freshInv();
      this.player.tools = { axe: 1, pickaxe: 1, rod: 1, sword: 1 };
      this.player.skills = freshSkills();
      this.player.bank = freshInv();
      this.player.listings = [];
      this.player.owned = { axe: false, pickaxe: false, rod: false, sword: false };
      this.player.learned = { chop: false, fish: false, mine: false, fight: false };
    }
    this.player.equipped = TOOL_ORDER.find(t => this.player.owned[t]) || 'axe';
    // veterans (existing saves) skip the warning; brand-new players see it once
    this.player.warnedWild = d ? (d.warnedWild ?? true) : false;
    this.player.questDone = d ? (d.questDone ?? true) : false;   // beginner quest completion (popup shown once)
    this.player.username = (d && d.username) || null;
    if (this.player.username) this.player.label.setText(this.player.username);   // saved name overrides the wallet/guest label
    this.player.hp = this.player.maxHp; this.player.dead = false; this.clearCombat();

    // realm — (re)build if different from the current one
    const targetRealm = (d && d.realm && REALMS[d.realm]) ? d.realm : 'mainland';
    if (targetRealm !== this.realm) { this.clearRealm(); this.buildRealm(targetRealm); }

    // position
    if (d && typeof d.gx === 'number' && this.isWalkable(Math.round(d.gx), Math.round(d.gy))) {
      this.player.gx = d.gx; this.player.gy = d.gy;
    } else {
      const sp = REALMS[targetRealm].spawn; this.player.gx = sp.x; this.player.gy = sp.y;
    }

    this.cancelGather(); this.cancelFishing(); this.player.path = [];
    this.portalCooldown = 1.0;
    this.placeEntity(this.player);
    this.cameras.main.centerOn(this.player.sprite.x, this.player.sprite.y);
    this.refreshInventory(); this.updateSkills(); this.updateHotbar(); this.updateToolSprite(); this.updateHealthHUD(); this.updateObjectives();
  }

  saveProfile() {
    const p = this.player;
    localStorage.setItem('kintara_save_' + p.saveKey, JSON.stringify({
      inv: p.inv, bank: p.bank, listings: p.listings, tools: p.tools, owned: p.owned, learned: p.learned, skills: p.skills, warnedWild: p.warnedWild, questDone: p.questDone, username: p.username, gx: p.gx, gy: p.gy, realm: this.realm, savedAt: Date.now(),
    }));
  }

  // =========================================================================
  //  HUD sync
  // =========================================================================
  refreshInventory() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const inv = this.player.inv;
    set('inv-wood', inv.wood); set('inv-stone', inv.stone); set('inv-coal', inv.coal); set('inv-fish', inv.fish);
    set('inv-cookedfish', inv.cookedfish || 0); set('inv-coins', inv.coins || 0);
  }

  updateSkills() {
    for (const el of document.querySelectorAll('#skills .skill')) {
      const s = this.player.skills[el.dataset.skill];
      el.querySelector('.lv').textContent = 'Lv ' + s.level;
      const pct = s.level >= SKILL_CAP ? 100 : Math.min(100, (s.xp / xpToNext(s.level)) * 100);
      el.querySelector('.xp-fill').style.width = pct + '%';
    }
  }

  updateHotbar() {
    for (const slot of document.querySelectorAll('#hotbar .slot')) {
      const id = slot.dataset.tool, owned = this.player.owned[id];
      slot.classList.toggle('active', owned && id === this.player.equipped);
      for (const sel of ['.slot-ic', '.tier', '.name']) {        // empty slot until the tool is collected
        const el = slot.querySelector(sel); if (el) el.style.visibility = owned ? 'visible' : 'hidden';
      }
      slot.querySelector('.tier').textContent = owned ? 'L' + this.player.tools[id] : '';
    }
  }

  bindHotbarClicks() {
    document.querySelectorAll('#hotbar .slot').forEach(slot =>
      slot.addEventListener('click', () => this.equipTool(slot.dataset.tool)));
  }

  toast(msg, kind) {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    this.time.delayedCall(2200, () => {
      el.style.transition = 'opacity .3s'; el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    });
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// =============================================================================
//  Wallet connect (login identity only — no transactions, no tokens)
// =============================================================================
(function setupWallet() {
  const btn = document.getElementById('connect-btn');
  const info = document.getElementById('wallet-info');
  const addrEl = document.getElementById('wallet-addr');
  const whoEl = document.getElementById('wallet-who');
  const disc = document.getElementById('disconnect');
  const short = (a) => a.length > 12 ? a.slice(0, 5) + '…' + a.slice(-4) : a;

  function showConnected(provider, address) {
    whoEl.textContent = provider;
    addrEl.textContent = short(address);
    btn.style.display = 'none';
    info.style.display = 'inline-block';
    if (window.GAME) window.GAME.onLogin(short(address), provider + ':' + address);
    localStorage.setItem('kintara_last_wallet', JSON.stringify({ provider, address }));
  }

  async function connect() {
    try {
      if (window.solana && window.solana.isPhantom) {
        const resp = await window.solana.connect();
        return showConnected('Phantom', resp.publicKey.toString());
      }
      if (window.ethereum) {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (accounts && accounts[0]) return showConnected('MetaMask', accounts[0]);
      }
      alert('No wallet found. Install Phantom (Solana) or MetaMask (EVM) to log in, or keep playing as Guest.');
    } catch (e) { console.warn('Wallet connect cancelled/failed:', e); }
  }

  function disconnect() {
    try { if (window.solana && window.solana.disconnect) window.solana.disconnect(); } catch (_) {}
    btn.style.display = 'inline-block';
    info.style.display = 'none';
    localStorage.removeItem('kintara_last_wallet');
    if (window.GAME) window.GAME.onLogout();
  }

  btn.addEventListener('click', connect);
  disc.addEventListener('click', disconnect);

  window.addEventListener('load', async () => {
    const raw = localStorage.getItem('kintara_last_wallet');
    if (!raw) return;
    try {
      const { provider, address } = JSON.parse(raw);
      if (provider === 'Phantom' && window.solana && window.solana.isPhantom) {
        const resp = await window.solana.connect({ onlyIfTrusted: true });
        return showConnected('Phantom', resp.publicKey.toString());
      }
      showConnected(provider, address);
    } catch (_) { /* user must click Connect again */ }
  });
})();

// =============================================================================
//  Boot
// =============================================================================
new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0c1430',
  scene: [WorldScene],
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true },
});
