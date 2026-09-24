// A demo POPULATION: 50 individual users and 10 verified organisations, each
// with real-looking listings, so the feed, browse, the matcher and the org
// storefronts have something to show that is not the four prisma/seed.ts
// accounts.
//
//   npx tsx --tsconfig tsconfig.json scripts/seed-demo-population.ts            # apply (idempotent)
//   npx tsx --tsconfig tsconfig.json scripts/seed-demo-population.ts --remove   # delete it again
//   (add --live for the live database -- see scripts/lib/live-guard.ts, and
//    take a backup first with scripts\backup-baylo-pg.ps1)
//
// ── HOW TO RECOGNISE A ROW FROM THIS SCRIPT ─────────────────────────────────
//
// There is no "is demo" flag on User or Item, so the marker is twofold:
//
//   EMAIL  every account is @baylo-demo.test. `.test` is reserved (RFC 2606),
//          so no mail can ever be delivered to one and no real person can own
//          one. Individuals are demo-user-01..50, org owners org-demo-01..10,
//          and each org's backing row is org-demo-NN+shop.
//   ID     every row this script creates has an explicit id starting
//          `demo-pop-`, the same convention as seed-demo-brackets.ts's
//          `demo-brk-`. --remove matches on BOTH, so a real account that
//          somebody registered at this domain by hand is never touched.
//   BIO    each account's bio ends "(Demo account.)" so a person looking at a
//          profile in the app can tell.
//
// ── WHY THE ORG LOGIN IS THE OWNER, NOT THE ORG ─────────────────────────────
//
// An organisation's backing User row never logs in: it has no password and
// POST /api/auth/token refuses an isOrgAccount row outright. Humans act as an
// org through OrganizationMember. So org-demo-NN@baylo-demo.test is the org's
// OWNER -- a person, with the shared password -- and posting "as the shop" is
// what the app does when that person switches to the org. Exactly the shape
// createOrganization() in @/lib/organizations produces.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
//
//   NO LEAVES.  Every account starts at 0 with no ledger rows, and
//               signupGrantClaimed is set true -- the same faucet guard
//               createOrganization() uses -- so no later verification can pay
//               sixty synthetic accounts a signup grant. SUM(User.leaves) ==
//               SUM(LeafTransaction.amount) is untouched. The org welcome
//               grant the admin route pays on approval is skipped for the same
//               reason: this is not a review, so it is not written as one (no
//               AdminAction row, reviewedById null).
//   NO HTTP.    Listings are written through Prisma, not POST /api/items, so
//               there is no FIRST_LISTING award (a mint), no quest settlement,
//               and -- the one that matters -- no category-match notification
//               to real users (see the 24 Sep 2026 harness incident).
//   NO RAW SQL. Only the Prisma client, which honours ?schema=.
//
// ── WHAT IT DOES REUSE ──────────────────────────────────────────────────────
//
// Values are not typed in as final numbers. Each listing carries the value an
// owner would ASK for (or none), and decideItemValue() -- the create route's
// own function -- decides the suggestion, the source and whether it is
// user-set. A perishable then goes through decidePerishableValue(), exactly as
// on the route. A standard listing whose ask would need an admin review takes
// the suggestion instead, because a demo listing sitting in PENDING_REVIEW is
// invisible. Images are the per-category photos prisma/seed.ts uses.
//
// ── PERISHABLES EXPIRE, AND A RE-RUN RE-POSTS THEM ─────────────────────────
//
// A perishable's window is counted from createdAt, and the lazy sweep on
// /home and /browse moves it to EXPIRED once that passes -- within 24 hours of
// seeding. Re-running this script puts every EXPIRED demo perishable that
// nobody has offered on back to AVAILABLE with a fresh createdAt. Nothing else
// is rewritten on a re-run: an existing account keeps its row (the password is
// reset to the shared one), and an existing listing is left exactly as it is.

import bcrypt from "bcryptjs"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { CATEGORY_IMAGES } from "../src/lib/category-images"
import { decideItemValue } from "../src/lib/valuation-server"
import { decidePerishableValue } from "../src/lib/perishable"
import { bracketOf } from "../src/lib/brackets"

const DOMAIN = "baylo-demo.test"
const ID_PREFIX = "demo-pop-"
const PASSWORD = "DemoPass2026!"
const BCRYPT_ROUNDS = 12 // prisma/seed.ts's figure
const CREDENTIALS_FILE = resolve(__dirname, "../../backups/demo-accounts-credentials.txt")

const pad = (n: number) => String(n).padStart(2, "0")
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

const CITIES = [
  "Cebu City", "Mandaue City", "Lapu-Lapu City", "Talisay City",
  "Consolacion", "Minglanilla", "Liloan",
]

// ── Listing catalogues ───────────────────────────────────────────────────────
//
// [title, category, condition, asked value (null = take the suggestion),
//  description, wanted, lookingForCategories]

type Row = [string, string, string, number | null, string, string, string[]]

const STANDARD: Row[] = [
  ["iPhone 12, 128GB, blue", "ELECTRONICS", "GOOD", 1400, "Battery health 84%, Face ID works, small scuff on the frame. With case.", "Android phone or a laptop", ["ELECTRONICS"]],
  ["Canon EOS M50 with kit lens", "ELECTRONICS", "LIKE_NEW", 2200, "Shutter count under 5k. Two batteries and a 64GB card.", "A drone or a gaming console", ["ELECTRONICS", "GAMING"]],
  ["Denim jacket, Levi's, size M", "CLOTHING", "GOOD", 180, "Classic trucker cut, lightly faded. No tears.", "Sneakers size 9", ["CLOTHING"]],
  ["Jansport backpack, black", "BAGS", "GOOD", 150, "Laptop sleeve fits 15 inches. Zippers all good.", "Books or school supplies", ["BOOKS", "OTHER"]],
  ["Wooden study desk", "FURNITURE", "FAIR", 600, "Solid wood, one drawer. Some marks on the top, sturdy.", "Office chair or a bookshelf", ["FURNITURE"]],
  ["Harry Potter box set, paperback", "BOOKS", "GOOD", 160, "All seven books, spines slightly creased.", "Other novels or a board game", ["BOOKS", "TOYS"]],
  ["PS4 Slim 500GB + 2 controllers", "GAMING", "GOOD", 1800, "Works perfectly, comes with GTA V and FIFA 21 discs.", "Nintendo Switch or a monitor", ["GAMING", "ELECTRONICS"]],
  ["Yoga mat and blocks set", "SPORTS", "LIKE_NEW", 220, "6mm mat, two foam blocks, strap. Used twice.", "Dumbbells or a jump rope", ["SPORTS"]],
  ["Mountain bike, 27.5, Shimano gears", "BIKES", "GOOD", 2400, "Aluminium frame, hydraulic brakes, new tyres.", "Road bike or a laptop", ["BIKES", "ELECTRONICS"]],
  ["LEGO Classic bucket, 900 pcs", "TOYS", "GOOD", 200, "Complete-ish, sorted by colour. Great for kids.", "Kids' books or puzzles", ["TOYS", "BOOKS"]],
  ["Makita cordless drill", "TOOLS", "GOOD", 700, "18V, two batteries, charger and a bit set.", "Circular saw or garden tools", ["TOOLS"]],
  ["Yamaha acoustic guitar F310", "MUSIC", "GOOD", 900, "Good action, new strings. Soft case included.", "Ukulele or a keyboard", ["MUSIC"]],
  ["Framed watercolour, Cebu sunset", "ART", "NEW", 300, "Original painting, 12x16, framed in wood.", "Another artwork or plants", ["ART", "PLANTS"]],
  ["Pokemon cards binder, 200 cards", "COLLECTIBLES", "GOOD", 500, "Mixed sets, some holos. Binder included.", "Other trading cards", ["COLLECTIBLES"]],
  ["Cat tree, 4 levels", "PETS", "FAIR", 250, "Scratching posts worn but stable. Our cat outgrew it.", "Pet carrier or cat food", ["PETS"]],
  ["Snake plant in ceramic pot", "PLANTS", "GOOD", 120, "About 2 ft tall, healthy, easy care.", "Other houseplants", ["PLANTS"]],
  ["Ray-Ban Wayfarer sunglasses", "ACCESSORIES", "LIKE_NEW", 800, "Authentic, with case and cloth. No scratches.", "Watch or a bag", ["ACCESSORIES", "BAGS"]],
  ["Skincare bundle, unopened", "BEAUTY", "NEW", 250, "Cleanser, toner and moisturiser, all sealed.", "Makeup or fragrance", ["BEAUTY"]],
  ["Logitech MX Master 3 mouse", "ELECTRONICS", "LIKE_NEW", 450, "Graphite, USB-C, with receiver. Barely used.", "Mechanical keyboard", ["ELECTRONICS"]],
  ["Office chair, mesh back", "FURNITURE", "GOOD", 700, "Adjustable height and armrests. Wheels roll smoothly.", "Standing desk or monitor", ["FURNITURE", "ELECTRONICS"]],
  ["Nike Air Force 1, size 9", "CLOTHING", "GOOD", 400, "White, cleaned. Soles have plenty of life left.", "Running shoes size 9", ["CLOTHING", "SPORTS"]],
  ["Rice cooker, 1.8L", "OTHER", "GOOD", 180, "Standard model, inner pot has no scratches.", "Kitchen stuff or plants", ["OTHER", "PLANTS"]],
  ["Badminton set, 2 rackets + shuttles", "SPORTS", "GOOD", 180, "Yonex rackets, tube of feather shuttles.", "Table tennis set", ["SPORTS"]],
  ["Nintendo Switch Lite, turquoise", "GAMING", "GOOD", 1300, "With Pokemon Sword cartridge and a case.", "Tablet or phone", ["GAMING", "ELECTRONICS"]],
  ["Samsung 24-inch monitor", "ELECTRONICS", "GOOD", 800, "1080p IPS, HDMI cable included, no dead pixels.", "Keyboard or a desk", ["ELECTRONICS", "FURNITURE"]],
  ["Leather messenger bag", "BAGS", "GOOD", 450, "Genuine leather, brown, fits a 13-inch laptop.", "Backpack or shoes", ["BAGS", "CLOTHING"]],
  ["Cookbook collection, 5 books", "BOOKS", "GOOD", 120, "Filipino, baking and vegetarian cookbooks.", "Plants or kitchen tools", ["PLANTS", "OTHER"]],
  ["Electric fan, stand type", "OTHER", "GOOD", 200, "16-inch, three speeds, oscillates.", "Anything useful at home", ["OTHER", "FURNITURE"]],
  ["Road bike, carbon fork, 54cm", "BIKES", "LIKE_NEW", 3200, "Shimano Sora groupset, clipless pedals included.", "Laptop or a camera", ["ELECTRONICS", "BIKES"]],
  ["Board game bundle: Catan + Uno", "TOYS", "GOOD", 280, "Catan complete, Uno sealed.", "Other board games", ["TOYS"]],
  ["Hand tool kit, 108 pieces", "TOOLS", "LIKE_NEW", 400, "Sockets, screwdrivers, pliers in a hard case.", "Garden tools", ["TOOLS", "PLANTS"]],
  ["Ukulele, concert size", "MUSIC", "GOOD", 300, "Mahogany, with gig bag and tuner.", "Books or art supplies", ["BOOKS", "ART"]],
  ["Acrylic paint set + canvases", "ART", "NEW", 220, "24 colours, five 8x10 canvases, brushes.", "Sketchbooks or plants", ["ART", "PLANTS"]],
  ["Vintage Coca-Cola tin signs", "COLLECTIBLES", "FAIR", 350, "Set of three, some rust at the edges. Real vintage.", "Other collectibles", ["COLLECTIBLES"]],
  ["Dog crate, medium", "PETS", "GOOD", 280, "Foldable wire crate with plastic tray.", "Dog food or toys", ["PETS"]],
  ["Fiddle leaf fig, 3 ft", "PLANTS", "GOOD", 200, "Healthy, repotted last month.", "Monstera or succulents", ["PLANTS"]],
  ["Casio G-Shock, black", "ACCESSORIES", "GOOD", 600, "Works perfectly, band slightly worn.", "Sunglasses or a wallet", ["ACCESSORIES"]],
  ["Hair dryer + straightener set", "BEAUTY", "GOOD", 300, "Philips, both work well.", "Skincare or makeup", ["BEAUTY"]],
  ["Bluetooth speaker, JBL Flip 5", "ELECTRONICS", "GOOD", 600, "Loud and waterproof, charges via USB-C.", "Headphones", ["ELECTRONICS", "MUSIC"]],
  ["Bookshelf, 5 tiers", "FURNITURE", "GOOD", 400, "Particle board, white, easy to assemble.", "Desk lamp or books", ["BOOKS", "FURNITURE"]],
  ["Formal barong, size L", "CLOTHING", "LIKE_NEW", 350, "Worn once to a wedding. Pina-like fabric.", "Polo shirts or shoes", ["CLOTHING"]],
  ["Travel luggage, 24-inch", "BAGS", "GOOD", 500, "Hard shell, four spinner wheels, TSA lock.", "Backpack or electronics", ["BAGS", "ELECTRONICS"]],
  ["Self-help books, 6 titles", "BOOKS", "GOOD", 150, "Atomic Habits, Deep Work and four more.", "Novels", ["BOOKS"]],
  ["Xbox controller, wireless", "GAMING", "GOOD", 350, "Works on PC and Xbox, batteries included.", "Games or a headset", ["GAMING"]],
  ["Dumbbell set, 2x10kg", "SPORTS", "GOOD", 450, "Adjustable plates, spinlock handles.", "Yoga mat or a bike", ["SPORTS", "BIKES"]],
  ["Kids' bike, 16-inch", "BIKES", "FAIR", 400, "Training wheels included, needs new grips.", "Toys or kids' books", ["TOYS", "BOOKS"]],
  ["Stuffed toy lot, 10 pieces", "TOYS", "GOOD", 120, "Washed and clean, various characters.", "Books or puzzles", ["TOYS", "BOOKS"]],
  ["Garden tool set", "TOOLS", "GOOD", 250, "Trowel, rake, pruners and gloves.", "Plants or seeds", ["PLANTS"]],
  ["Digital piano, 88 keys", "MUSIC", "GOOD", 2800, "Weighted keys, stand and sustain pedal.", "Guitar or a laptop", ["MUSIC", "ELECTRONICS"]],
  ["Hand-carved wooden figurine", "ART", "NEW", 250, "Narra wood carabao, made in Bohol.", "Other handicrafts", ["ART", "COLLECTIBLES"]],
  ["Hot Wheels collection, 40 cars", "COLLECTIBLES", "GOOD", 400, "Mixed years, some still carded.", "Other diecast", ["COLLECTIBLES", "TOYS"]],
  ["Aquarium, 20 gallons, complete", "PETS", "GOOD", 500, "Filter, heater, light and gravel included.", "Pet supplies", ["PETS"]],
  ["Succulent collection, 8 pots", "PLANTS", "GOOD", 150, "Assorted succulents in small clay pots.", "Other plants", ["PLANTS"]],
  ["Leather wallet, bifold", "ACCESSORIES", "LIKE_NEW", 150, "Brown genuine leather, several card slots.", "Belt or a watch", ["ACCESSORIES"]],
  ["Perfume, 100ml, 80% full", "BEAUTY", "GOOD", 350, "Designer scent, authentic, with box.", "Other fragrances", ["BEAUTY"]],
  ["Kindle Paperwhite, 10th gen", "ELECTRONICS", "GOOD", 700, "Waterproof, 8GB, cover included.", "Books or headphones", ["BOOKS", "ELECTRONICS"]],
  ["Dining chairs, set of 4", "FURNITURE", "FAIR", 500, "Wooden, sturdy, seats need re-varnishing.", "Table or cabinet", ["FURNITURE"]],
  ["Raincoat and rain boots set", "CLOTHING", "GOOD", 150, "Adult size, great for the rainy season.", "Umbrella or a bag", ["CLOTHING", "BAGS"]],
  ["Tote bags, set of 3", "BAGS", "NEW", 90, "Canvas, printed Cebu designs.", "Anything eco-friendly", ["OTHER"]],
  ["Programming books bundle", "BOOKS", "GOOD", 200, "JavaScript, Python and algorithms texts.", "Electronics or other books", ["BOOKS", "ELECTRONICS"]],
  ["Gaming headset, HyperX Cloud II", "GAMING", "GOOD", 500, "Detachable mic, USB sound card.", "Controller or keyboard", ["GAMING"]],
  ["Basketball, Molten GG7X", "SPORTS", "GOOD", 180, "Official size, good grip.", "Sports gear", ["SPORTS"]],
  ["Bike helmet and lights", "BIKES", "LIKE_NEW", 250, "Helmet size M, USB front and rear lights.", "Bike parts", ["BIKES"]],
  ["Wooden train set", "TOYS", "GOOD", 220, "30 pieces, tracks and bridge.", "Kids' clothes or books", ["CLOTHING", "BOOKS"]],
  ["Ladder, 6-step aluminium", "TOOLS", "GOOD", 350, "Folding, lightweight, anti-slip feet.", "Power tools", ["TOOLS"]],
  ["Cajon drum", "MUSIC", "GOOD", 450, "Snare wires inside, great for acoustic sets.", "Guitar or a mic", ["MUSIC"]],
  ["Photography prints, set of 5", "ART", "NEW", 180, "A4 prints of Cebu heritage sites.", "Frames or art", ["ART"]],
  ["Vinyl records, OPM classics", "COLLECTIBLES", "GOOD", 450, "Eight records, sleeves in fair shape.", "Turntable or records", ["COLLECTIBLES", "MUSIC"]],
  ["Hamster cage with accessories", "PETS", "GOOD", 150, "Wheel, water bottle and a hideout.", "Pet food", ["PETS"]],
  ["Orchid in bloom", "PLANTS", "GOOD", 180, "Purple phalaenopsis, two spikes.", "Other flowering plants", ["PLANTS"]],
  ["Silver necklace, 925", "ACCESSORIES", "LIKE_NEW", 300, "Simple chain with pendant, with box.", "Earrings or a watch", ["ACCESSORIES"]],
  ["Makeup palette bundle", "BEAUTY", "LIKE_NEW", 200, "Eyeshadow palettes, swatched only.", "Skincare", ["BEAUTY"]],
  ["Tutoring: high-school math, 4 sessions", "SERVICES", "NEW", 500, "Algebra, geometry and trig, one hour each, online or in Cebu City.", "Guitar lessons or books", ["SERVICES", "BOOKS"]],
  ["Graphic design: logo package", "SERVICES", "NEW", 700, "Three concepts, two revisions, final files.", "Photography or electronics", ["SERVICES", "ELECTRONICS"]],
  ["Camping tent, 4-person", "SPORTS", "GOOD", 600, "Waterproof, poles and pegs complete.", "Sleeping bags or a cooler", ["SPORTS", "OTHER"]],
]

// Perishables: food and flowers, [title, category, condition, asked, desc,
// wanted, looking-for] plus quantity/unit/window in PERISHABLE_EXTRA below.
const PERISHABLE: Row[] = [
  ["Ripe Guimaras mangoes", "FOOD", "NEW", 80, "Sweet carabao mangoes, picked yesterday.", "Vegetables or eggs", ["FOOD"]],
  ["Homemade ube halaya", "FOOD", "NEW", 60, "Made this morning, in a sealed tub.", "Baked goods", ["FOOD"]],
  ["Fresh pandesal, 30 pcs", "FOOD", "NEW", 40, "From our home bakery, still warm at 6am.", "Coffee or eggs", ["FOOD"]],
  ["Lechon manok, whole", "FOOD", "NEW", 90, "Roasted today, garlic rice not included.", "Fruits or drinks", ["FOOD"]],
  ["Garden tomatoes", "FOOD", "NEW", 30, "Organic, from our backyard.", "Herbs or seeds", ["PLANTS", "FOOD"]],
  ["Fresh tuna, from the market", "FOOD", "NEW", 100, "Bought at Pasil market this morning, kept on ice.", "Vegetables", ["FOOD"]],
  ["Bibingka, 6 pieces", "FOOD", "NEW", 45, "Baked in banana leaves with salted egg.", "Any snacks", ["FOOD"]],
  ["Buko juice, fresh", "FOOD", "NEW", 35, "Young coconuts opened today, chilled.", "Fruits", ["FOOD"]],
  ["Bouquet of sunflowers", "PLANTS", "NEW", 70, "Ten stems, cut this morning.", "Other flowers or plants", ["PLANTS"]],
  ["Kangkong bundles", "FOOD", "NEW", 20, "Fresh water spinach, five bundles.", "Rice or eggs", ["FOOD"]],
  ["Chocolate chip cookies", "FOOD", "NEW", 50, "Two dozen, baked today, no preservatives.", "Fruits or milk", ["FOOD"]],
  ["Leche flan, 2 llaneras", "FOOD", "NEW", 70, "Creamy, made with farm eggs.", "Other desserts", ["FOOD"]],
  ["Fresh eggs, native chicken", "FOOD", "NEW", 50, "Free range, collected this morning.", "Vegetables or bread", ["FOOD"]],
  ["Lumpiang shanghai, frozen pack", "FOOD", "NEW", 60, "50 pieces, homemade, keep frozen.", "Anything tasty", ["FOOD"]],
  ["Calamansi, freshly picked", "FOOD", "NEW", 25, "From our tree, great for juice.", "Other fruits", ["FOOD"]],
  ["Roses, a dozen, red", "PLANTS", "NEW", 90, "Long stems from a Busay flower farm.", "Chocolates or plants", ["PLANTS", "FOOD"]],
  ["Puto cheese, 20 pcs", "FOOD", "NEW", 40, "Soft rice cakes with cheese topping.", "Other kakanin", ["FOOD"]],
  ["Bananas, lakatan, 2 bunches", "FOOD", "NEW", 35, "Ripe and sweet, from Carcar.", "Vegetables", ["FOOD"]],
  ["Adobo in a jar, 2 jars", "FOOD", "NEW", 70, "Pork adobo, cooked today, refrigerate.", "Rice or bread", ["FOOD"]],
  ["Fresh lettuce, hydroponic", "FOOD", "NEW", 30, "Romaine and butterhead, grown at home.", "Herbs", ["FOOD", "PLANTS"]],
  ["Turon, 15 pieces", "FOOD", "NEW", 30, "Banana and langka spring rolls, crispy.", "Snacks", ["FOOD"]],
  ["Crabs, live, from Bantayan", "FOOD", "NEW", 120, "Mud crabs, still alive, cook today.", "Seafood or vegetables", ["FOOD"]],
  ["Ensaymada, box of 6", "FOOD", "NEW", 60, "Buttery and topped with cheese.", "Coffee beans", ["FOOD"]],
  ["Papaya, ripe, 3 pieces", "FOOD", "NEW", 30, "From our garden, perfect for breakfast.", "Other fruits", ["FOOD"]],
  ["Chrysanthemum bouquet", "PLANTS", "NEW", 60, "Mixed colours, fresh cut.", "Plants", ["PLANTS"]],
  ["Palabok tray", "FOOD", "NEW", 90, "Good for 8, cooked for a party, extra tray.", "Drinks or desserts", ["FOOD"]],
  ["Squash, 2 large", "FOOD", "NEW", 25, "Kalabasa from our farm in Balamban.", "Other vegetables", ["FOOD"]],
  ["Maja blanca, 1 tray", "FOOD", "NEW", 45, "Corn and coconut pudding, sliced.", "Other desserts", ["FOOD"]],
  ["Dried fish, danggit, fresh batch", "FOOD", "NEW", 80, "Sun-dried this week, from Bantayan.", "Rice or vegetables", ["FOOD"]],
  ["Strawberries from Dalaguete", "FOOD", "NEW", 90, "Freshly harvested, keep chilled.", "Other fruits", ["FOOD"]],
  ["Banana cake loaf", "FOOD", "NEW", 40, "Moist, baked this morning.", "Coffee or fruits", ["FOOD"]],
  ["Siomai, 40 pcs, frozen", "FOOD", "NEW", 50, "Pork siomai with chili garlic sauce.", "Anything", ["FOOD"]],
  ["Pineapples, 3 pieces", "FOOD", "NEW", 45, "Sweet, from a Bukidnon relative.", "Vegetables", ["FOOD"]],
  ["Okra and eggplant bundle", "FOOD", "NEW", 20, "From our backyard garden.", "Eggs", ["FOOD"]],
  ["Sampaguita garlands, 10", "PLANTS", "NEW", 40, "Hand-strung this morning.", "Flowers or plants", ["PLANTS"]],
  ["Chicken inasal, 4 sticks", "FOOD", "NEW", 70, "Grilled today, Bacolod style.", "Drinks", ["FOOD"]],
  ["Taho, 1 litre", "FOOD", "NEW", 20, "Fresh silken tofu with arnibal and sago.", "Bread", ["FOOD"]],
  ["Mangosteen, 1 kilo", "FOOD", "NEW", 70, "From Davao, just arrived.", "Other fruits", ["FOOD"]],
  ["Carrot cake, whole", "FOOD", "NEW", 90, "Cream cheese frosting, eight slices.", "Other baked goods", ["FOOD"]],
  ["Malunggay leaves, bundles", "FOOD", "NEW", 15, "Fresh from the tree, five bundles.", "Anything", ["FOOD"]],
  ["Pancit canton, party tray", "FOOD", "NEW", 80, "Good for 10, cooked this morning.", "Desserts", ["FOOD"]],
  ["Rambutan, 2 kilos", "FOOD", "NEW", 50, "Sweet and fresh.", "Other fruits", ["FOOD"]],
  ["Kutsinta, 30 pcs", "FOOD", "NEW", 30, "With grated coconut on the side.", "Other kakanin", ["FOOD"]],
  ["Shrimp, fresh, 1 kilo", "FOOD", "NEW", 110, "Suahe from the morning market, on ice.", "Vegetables", ["FOOD"]],
  ["Tulip-style lilies, 6 stems", "PLANTS", "NEW", 80, "Bought for an event, still fresh.", "Plants", ["PLANTS"]],
  ["Polvoron, 50 pcs", "FOOD", "NEW", 40, "Classic and pinipig flavours, wrapped.", "Other sweets", ["FOOD"]],
  ["Avocados, 5 pieces", "FOOD", "NEW", 45, "Ripe in two days, from Mantalongon.", "Fruits", ["FOOD"]],
  ["Sinigang vegetables kit", "FOOD", "NEW", 30, "Radish, kangkong, sitaw and tomatoes.", "Meat or fish", ["FOOD"]],
  ["Brownies, a dozen", "FOOD", "NEW", 50, "Fudgy, baked today.", "Coffee or fruits", ["FOOD"]],
  ["Lanzones, 2 kilos", "FOOD", "NEW", 60, "Sweet, from Camiguin.", "Other fruits", ["FOOD"]],
]

// quantity, unit, window hours -- index-aligned with PERISHABLE.
const PERISHABLE_EXTRA: [number | null, "KG" | "PCS" | "LITERS" | null, 6 | 24][] = PERISHABLE.map((row, i) => {
  const unitGuess: "KG" | "PCS" | "LITERS" =
    /juice|taho/i.test(row[0]) ? "LITERS" : /kilo|mango|tuna|shrimp|crab|squash|calamansi|danggit/i.test(row[0]) ? "KG" : "PCS"
  const qty = unitGuess === "LITERS" ? 1 + (i % 2) : unitGuess === "KG" ? 1 + (i % 3) * 0.5 : [6, 10, 12, 20, 30][i % 5]
  // Most get a day; every fourth is a same-day, six-hour listing.
  const window = i % 4 === 3 ? 6 : 24
  // "Bouquet", "bundle", "tray" -- a quantity would be a lie; leave both null.
  return /bouquet|tray|garland|loaf|cake,|cake loaf|kit/i.test(row[0]) ? [null, null, window] : [qty, unitGuess, window]
})

type OrgSeed = {
  name: string
  category: string
  owner: string
  description: string
  items: Row[]
}

const ORGS: OrgSeed[] = [
  { name: "Tindahan ni Aling Nena", category: "SARI_SARI", owner: "Nena Villanueva",
    description: "Neighbourhood sari-sari store in Mabolo since 1998. We trade household goods for what our suki need.",
    items: [
      ["Rice dispenser, 12kg", "OTHER", "NEW", 250, "Sealed, push-button dispenser. Surplus stock.", "Canned goods for resale", ["FOOD", "OTHER"]],
      ["Plastic storage bins, set of 5", "OTHER", "NEW", 180, "Stackable, with lids.", "Household items", ["OTHER"]],
      ["Chest freezer, 5 cu ft", "OTHER", "GOOD", 1400, "Replaced with a bigger one. Runs cold and quiet.", "Display chiller or shelving", ["FURNITURE", "OTHER"]],
    ] },
  { name: "Kape Sugbo Roasters", category: "FOOD_AND_BEVERAGE", owner: "Paolo Ybanez",
    description: "Small-batch coffee roaster in Banilad sourcing beans from Cebu highland farms.",
    items: [
      ["Manual espresso grinder", "OTHER", "LIKE_NEW", 450, "Conical burrs, from our tasting bar.", "Barista tools", ["OTHER"]],
      ["Roasted coffee beans, 1kg, sealed", "FOOD", "NEW", 90, "Medium roast, sealed valve bag, best in 3 months.", "Packaging supplies", ["OTHER"]],
    ] },
  { name: "Balamban Highland Farmers Assoc.", category: "AGRICULTURE", owner: "Ramon Pepito",
    description: "Farmers' association growing vegetables and cut flowers in the Balamban highlands.",
    items: [
      ["Knapsack sprayer, 16L", "TOOLS", "GOOD", 400, "Manual pump, all seals replaced.", "Farm tools", ["TOOLS"]],
      ["Seedling trays, 50 pcs", "PLANTS", "NEW", 150, "128-cell trays, reusable.", "Seeds or fertiliser", ["PLANTS"]],
      ["Garden hose, 30m", "TOOLS", "NEW", 200, "Heavy duty, with spray nozzle.", "Tools", ["TOOLS"]],
    ] },
  { name: "Habi Bohol Weavers", category: "HANDICRAFT", owner: "Liza Ompad",
    description: "Women-led cooperative weaving banig mats and bags from tikog and buri.",
    items: [
      ["Handwoven banig mat, queen", "ART", "NEW", 500, "Tikog grass, natural dyes, woven by hand over two weeks.", "Sewing supplies", ["OTHER", "ART"]],
      ["Buri tote bag", "BAGS", "NEW", 250, "Lined interior, leather handles.", "Fabric or thread", ["OTHER"]],
    ] },
  { name: "Tahi Cebu Apparel", category: "APPAREL", owner: "Marco Dela Pena",
    description: "Small garment studio making uniforms and made-to-order shirts in Mandaue.",
    items: [
      ["Embroidered polo barong, M", "CLOTHING", "NEW", 450, "Sample piece from our 2026 line.", "Sewing machine parts", ["TOOLS"]],
      ["Plain cotton shirts, 10 pcs", "CLOTHING", "NEW", 300, "Assorted sizes, ready for printing.", "Fabric", ["OTHER"]],
      ["Industrial sewing machine", "TOOLS", "GOOD", 2200, "Juki straight stitch, serviced this year.", "Overlock machine", ["TOOLS"]],
    ] },
  { name: "FixIt Gadget Clinic", category: "ELECTRONICS_REPAIR", owner: "Kevin Sy",
    description: "Phone and laptop repair shop in Colon. Refurbished units, tested and warrantied.",
    items: [
      ["Refurbished ThinkPad T480", "ELECTRONICS", "GOOD", 2000, "i5, 8GB, 256GB SSD, new battery. 30-day shop warranty.", "Broken phones for parts", ["ELECTRONICS"]],
      ["Refurbished Android phone, Redmi Note 11", "ELECTRONICS", "GOOD", 900, "New screen, tested, factory reset.", "Tools or parts", ["ELECTRONICS", "TOOLS"]],
    ] },
  { name: "Linis Pro Home Services", category: "SERVICES", owner: "Grace Abellana",
    description: "Home cleaning and aircon servicing team covering Metro Cebu.",
    items: [
      ["Aircon cleaning, 1 unit", "SERVICES", "NEW", 400, "Window or split type, chemical wash, Metro Cebu.", "Cleaning supplies", ["OTHER"]],
      ["Deep cleaning, 2-bedroom home", "SERVICES", "NEW", 900, "Four-hour team clean including kitchen and bath.", "Vacuum or equipment", ["ELECTRONICS", "TOOLS"]],
      ["Pressure washer, used", "TOOLS", "FAIR", 700, "Replaced with a newer unit. Works, hose is patched.", "Cleaning equipment", ["TOOLS"]],
    ] },
  { name: "Ukay Finds Mandaue", category: "RETAIL", owner: "Joy Canete",
    description: "Curated secondhand clothing and bags, sorted and cleaned.",
    items: [
      ["Vintage denim bundle, 5 pcs", "CLOTHING", "GOOD", 350, "Assorted jeans and jackets, washed.", "Clothing racks", ["FURNITURE"]],
      ["Branded handbag, preloved", "BAGS", "GOOD", 800, "Authentic, some wear on the corners.", "Display fixtures", ["FURNITURE"]],
    ] },
  { name: "Sugbo Fisherfolk Cooperative", category: "COOPERATIVE", owner: "Dante Mahusay",
    description: "Cooperative of small-scale fishers in Cordova supporting sustainable catch.",
    items: [
      ["Cooler box, 50L", "OTHER", "GOOD", 400, "Keeps ice for two days.", "Fishing gear", ["SPORTS", "TOOLS"]],
      ["Fishing nets, repaired, 2 pcs", "TOOLS", "FAIR", 300, "Mended, usable for shallow water.", "Rope or floats", ["TOOLS"]],
      ["Life vests, 4 pcs", "SPORTS", "GOOD", 350, "Adult sizes, all buckles work.", "Boat supplies", ["SPORTS"]],
    ] },
  { name: "Libro Para Sa Lahat", category: "NONPROFIT", owner: "Carmela Tan",
    description: "Volunteer group collecting books for barangay reading corners.",
    items: [
      ["Children's picture books, 20 pcs", "BOOKS", "GOOD", 180, "Donated duplicates, English and Cebuano.", "Books or shelves", ["BOOKS", "FURNITURE"]],
      ["Encyclopedia set, 1990s", "BOOKS", "FAIR", 200, "Complete set, some yellowing.", "School supplies", ["BOOKS", "OTHER"]],
    ] },
]

const FIRST = [
  "Maria", "Juan", "Angelica", "Mark", "Kristine", "John Paul", "Rhea", "Carlo", "Jasmine", "Miguel",
  "Patricia", "Joshua", "Clarisse", "Rafael", "Bea", "Christian", "Hazel", "Vincent", "Trisha", "Nico",
  "Andrea", "Gabriel", "Nicole", "Paolo", "Samantha", "Adrian", "Camille", "Jerome", "Mae", "Lorenzo",
  "Ella", "Dominic", "Faith", "Ramon", "Janine", "Kyle", "Lovely", "Aldrin", "Princess", "Bryan",
  "Shaira", "Ivan", "Denise", "Marvin", "Kaye", "Rico", "Jessa", "Noel", "Mika", "Arnel",
]
const LAST = [
  "Santos", "Reyes", "Cruz", "Bautista", "Gonzales", "Garcia", "Mendoza", "Torres", "Tomas", "Aquino",
  "Navarro", "Ramos", "Villanueva", "Castillo", "Flores", "Rivera", "Lim", "Tan", "Go", "Uy",
  "Alcantara", "Cabrera", "Salazar", "Dizon", "Pacquiao", "Labrador", "Cuenca", "Ybanez", "Sanchez", "Osmena",
  "Gullas", "Abella", "Rama", "Borromeo", "Climaco", "Lopez", "Diaz", "Moreno", "Castro", "Perez",
  "Jumao-as", "Cortes", "Pepito", "Ompad", "Canete", "Mahusay", "Tabada", "Sarmiento", "Estrella", "Sy",
]

// ── Plan ─────────────────────────────────────────────────────────────────────

type PlannedItem = {
  id: string
  row: Row
  perishable: null | { quantity: number | null; unit: "KG" | "PCS" | "LITERS" | null; hours: 6 | 24 }
  createdAt: Date
}
type PlannedAccount = {
  kind: "individual" | "org"
  id: string
  email: string
  name: string
  city: string
  dob: string
  bio: string
  org?: { id: string; backingId: string; backingEmail: string; seed: OrgSeed; dti: string }
  items: PlannedItem[]
}

function plan(): PlannedAccount[] {
  const out: PlannedAccount[] = []
  let std = 0
  for (let i = 1; i <= 50; i++) {
    const n = pad(i)
    const id = `${ID_PREFIX}u${n}`
    const items: PlannedItem[] = []
    // Odd-numbered users post two standard items, even-numbered one: 75 total.
    const count = i % 2 === 1 ? 2 : 1
    for (let k = 0; k < count; k++) {
      items.push({ id: `${id}-s${k + 1}`, row: STANDARD[std++], perishable: null, createdAt: daysAgo(1 + ((i * 7 + k * 3) % 21)) })
    }
    const [quantity, unit, hours] = PERISHABLE_EXTRA[i - 1]
    // Posted within the last few hours, and always well inside its window.
    items.push({ id: `${id}-p1`, row: PERISHABLE[i - 1], perishable: { quantity, unit, hours }, createdAt: hoursAgo((i % 4) * 0.5) })
    const first = FIRST[i - 1]
    const last = LAST[(i * 17) % LAST.length]
    const city = CITIES[i % CITIES.length]
    out.push({
      kind: "individual", id, email: `demo-user-${n}@${DOMAIN}`,
      name: `${first} ${last}`, city,
      dob: `${1980 + (i % 22)}-${pad(1 + (i % 12))}-${pad(1 + ((i * 3) % 28))}`,
      bio: `Trading what I no longer use around ${city}. (Demo account.)`,
      items,
    })
  }
  ORGS.forEach((o, j) => {
    const n = pad(j + 1)
    const id = `${ID_PREFIX}o${n}-owner`
    const backingId = `${ID_PREFIX}o${n}`
    out.push({
      kind: "org", id, email: `org-demo-${n}@${DOMAIN}`,
      name: o.owner, city: CITIES[j % CITIES.length],
      dob: `${1975 + j}-${pad(1 + j)}-15`,
      bio: `Owner of ${o.name}. (Demo account.)`,
      org: {
        id: `${ID_PREFIX}org${n}`, backingId, backingEmail: `org-demo-${n}+shop@${DOMAIN}`, seed: o,
        // Obviously not a DTI-issued number, on purpose: a realistic 7-digit
        // figure could be somebody's real business name registration.
        dti: `DEMO-BN-2026${n}`,
      },
      items: o.items.map((row, k) => ({ id: `${backingId}-s${k + 1}`, row, perishable: null, createdAt: daysAgo(2 + ((j * 5 + k * 4) % 20)) })),
    })
  })
  return out
}

// ── Apply ────────────────────────────────────────────────────────────────────

/** The one refusal: an address at our domain that this script did not create. */
async function assertNoForeignRows(accounts: PlannedAccount[]) {
  const emails = accounts.flatMap((a) => (a.org ? [a.email, a.org.backingEmail] : [a.email]))
  const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
  const foreign = rows.filter((r) => !r.id.startsWith(ID_PREFIX))
  if (foreign.length > 0) {
    throw new Error(
      `refusing: ${foreign.length} account(s) at @${DOMAIN} were not created by this script ` +
        `(${foreign.map((f) => `${f.email} = ${f.id}`).join(", ")}). Resolve by hand first.`,
    )
  }
  return new Set(rows.map((r) => r.email))
}

async function upsertPerson(a: PlannedAccount, passwordHash: string, grandfathered: boolean) {
  const shared = {
    name: a.name,
    password: passwordHash,
    location: a.city,
    bio: a.bio,
    dateOfBirth: new Date(a.dob),
  }
  await prisma.user.upsert({
    where: { email: a.email },
    create: {
      id: a.id,
      email: a.email,
      ...shared,
      // Verified, so login works. signupGrantClaimed with NO ledger row is the
      // faucet guard -- see the header: these accounts are never paid.
      isVerified: true,
      signupGrantClaimed: true,
      // Past the ID gate without a review, which is literally what happened.
      // Only individuals need it (they post personally); org owners post AS
      // the org, whose own VERIFIED status is the check.
      idVerifiedGrandfatheredAt: grandfathered ? new Date() : null,
      createdAt: daysAgo(25 + (Number(a.id.replace(/\D/g, "")) % 30)),
    },
    update: shared,
  })
}

async function upsertOrg(a: PlannedAccount) {
  const o = a.org!
  // Mirrors createOrganization() in @/lib/organizations field for field,
  // except the email, which carries the demo domain instead of a random uuid.
  await prisma.user.upsert({
    where: { email: o.backingEmail },
    create: {
      id: o.backingId,
      email: o.backingEmail,
      name: o.seed.name,
      password: null,
      isVerified: false,
      signupGrantClaimed: true,
      isOrgAccount: true,
      location: a.city,
      createdAt: daysAgo(25),
    },
    update: { name: o.seed.name },
  })
  const existing = await prisma.organization.findUnique({ where: { orgUserId: o.backingId }, select: { id: true } })
  if (!existing) {
    await prisma.organization.create({
      data: {
        id: o.id,
        orgUserId: o.backingId,
        name: o.seed.name,
        description: o.seed.description,
        businessCategory: o.seed.category as never,
        dtiRegistrationNumber: o.dti,
        // Straight to VERIFIED: no document was uploaded, so there is nothing
        // in Cloudinary to destroy and nothing for businessDocUrl to hold.
        // reviewedById stays null -- no admin reviewed this, and an AdminAction
        // row claiming one did would be a false audit record.
        verificationStatus: "VERIFIED",
        reviewedAt: new Date(),
        members: { create: { userId: a.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } },
      },
    })
  }
}

async function upsertItem(ownerId: string, p: PlannedItem, hubIds: string[], hubCursor: { i: number }) {
  const [title, category, condition, asked, description, wanted, lookingFor] = p.row
  const existing = await prisma.item.findUnique({
    where: { id: p.id },
    select: { status: true, isPerishable: true, _count: { select: { offers: true, offeredIn: true, requestedIn: true } } },
  })

  if (existing) {
    const touched = existing._count.offers + existing._count.offeredIn + existing._count.requestedIn
    if (existing.isPerishable && existing.status === "EXPIRED" && touched === 0) {
      await prisma.item.update({ where: { id: p.id }, data: { status: "AVAILABLE", createdAt: new Date() } })
      return "refreshed" as const
    }
    return "kept" as const
  }

  // The create route's own valuation, then its perishable rule.
  const valued = await decideItemValue(category, condition, asked)
  let data = valued.data
  if (p.perishable) data = decidePerishableValue(valued).data
  else if (valued.needsReview) {
    const fallback = await decideItemValue(category, condition, null)
    data = fallback.data
  }

  // One public meetup hub per listing when there are any; zero is normal.
  const hub = hubIds.length > 0 ? hubIds[hubCursor.i++ % hubIds.length] : null

  await prisma.item.create({
    data: {
      id: p.id,
      title,
      description,
      images: JSON.stringify([CATEGORY_IMAGES[category] ?? CATEGORY_IMAGES.OTHER]),
      category: category as never,
      condition: condition as never,
      ...data,
      status: "AVAILABLE",
      wantedItems: wanted,
      lookingForCategories: lookingFor as never,
      userId: ownerId,
      createdAt: p.createdAt,
      ...(p.perishable
        ? { isPerishable: true, quantity: p.perishable.quantity, quantityUnit: p.perishable.unit, tradeWithinHours: p.perishable.hours }
        : {}),
      ...(hub ? { safeZones: { create: [{ hubId: hub }] } } : {}),
    },
  })
  return "created" as const
}

async function apply() {
  const accounts = plan()
  const before = await assertNoForeignRows(accounts)
  console.log(`  ${before.size} demo account row(s) already present; hashing the shared password...`)
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS)

  const hubIds = (await prisma.safeZoneHub.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" } })).map((h) => h.id)
  const hubCursor = { i: 0 }
  const tally = { created: 0, kept: 0, refreshed: 0 }
  const brackets = new Map<number, number>()

  for (const a of accounts) {
    await upsertPerson(a, passwordHash, a.kind === "individual")
    if (a.org) await upsertOrg(a)
    const ownerId = a.org ? a.org.backingId : a.id
    for (const p of a.items) tally[await upsertItem(ownerId, p, hubIds, hubCursor)]++
    process.stdout.write(`\r  ${a.email.padEnd(34)}`)
  }
  console.log("\r" + " ".repeat(40))

  for (const it of await prisma.item.findMany({ where: { id: { startsWith: ID_PREFIX } }, select: { valueLeaves: true } })) {
    const b = bracketOf(it.valueLeaves ?? 0)
    brackets.set(b, (brackets.get(b) ?? 0) + 1)
  }
  console.log(`  listings: ${tally.created} created, ${tally.kept} already present, ${tally.refreshed} expired perishable(s) re-posted`)
  console.log(`  hubs attached from ${hubIds.length} active hub(s)`)
  console.log(`  by bracket: ${[...brackets.entries()].sort((x, y) => x[0] - y[0]).map(([b, n]) => `B${b}=${n}`).join("  ")}`)

  await writeCredentials(accounts)
}

async function writeCredentials(accounts: PlannedAccount[]) {
  const lines = [
    `Baylo demo population -- written ${new Date().toISOString()} by scripts/seed-demo-population.ts`,
    `Shared password for EVERY account below: ${PASSWORD}`,
    `Org accounts log in as the OWNER (a person) and switch to the shop in the app;`,
    `the shop's own backing row (org-demo-NN+shop@) cannot log in, by design.`,
    ``,
    `${"EMAIL".padEnd(34)} ${"TYPE".padEnd(11)} NAME / ORGANISATION`,
  ]
  for (const a of accounts) {
    lines.push(`${a.email.padEnd(34)} ${a.kind.padEnd(11)} ${a.org ? `${a.org.seed.name}  (owner: ${a.name}, ${a.org.seed.category})` : a.name}`)
  }
  lines.push("", `${accounts.length} accounts (${accounts.filter((a) => a.kind === "individual").length} individual, ${accounts.filter((a) => a.org).length} org).`)
  const text = lines.join("\n") + "\n"
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true })
  writeFileSync(CREDENTIALS_FILE, text)
  console.log("\n" + text)
  console.log(`  saved to ${CREDENTIALS_FILE}`)
}

// ── Remove ───────────────────────────────────────────────────────────────────

async function remove() {
  // BOTH markers, never one: the id is ours and the address is ours.
  const users = await prisma.user.findMany({
    where: { id: { startsWith: ID_PREFIX }, email: { endsWith: `@${DOMAIN}` } },
    select: {
      id: true, email: true, isOrgAccount: true,
      _count: {
        select: {
          sentOffers: true, receivedOffers: true, sentRequests: true, receivedRequests: true,
          sentMessages: true, receivedMessages: true, leafTransactions: true, contractsAsDebtor: true, contractsAsCreditor: true,
        },
      },
    },
  })
  if (users.length === 0) {
    console.log("  nothing to remove")
    return
  }
  // Backing rows first; the org and its memberships cascade with them.
  users.sort((x, y) => Number(y.isOrgAccount) - Number(x.isOrgAccount))
  let deleted = 0
  const kept: string[] = []
  for (const u of users) {
    const activity = Object.values(u._count).reduce((s, n) => s + n, 0)
    // Somebody traded, messaged or was paid while demoing: that is real state
    // on the other side too, and a cascade would take it with this row. Leave
    // it for a person to decide.
    if (activity > 0) {
      kept.push(`${u.email} (${activity} offer/trade/message/ledger rows)`)
      continue
    }
    await prisma.user.delete({ where: { id: u.id } })
    deleted++
  }
  console.log(`  ${deleted} account(s) deleted, with their listings`)
  if (kept.length) console.log(`  KEPT ${kept.length}, because they have activity:\n    ${kept.join("\n    ")}`)
}

async function main() {
  requireScratchSchema("scripts/seed-demo-population.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving the demo population" : "\nSeeding the demo population")
  if (removing) await remove()
  else await apply()

  const [users, orgs, live] = await Promise.all([
    prisma.user.count({ where: { id: { startsWith: ID_PREFIX }, email: { endsWith: `@${DOMAIN}` } } }),
    prisma.organization.count({ where: { id: { startsWith: ID_PREFIX } } }),
    prisma.item.count({ where: { id: { startsWith: ID_PREFIX }, status: "AVAILABLE" } }),
  ])
  console.log(`\n  now: ${users} demo user rows, ${orgs} demo organisations, ${live} demo listings AVAILABLE\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
