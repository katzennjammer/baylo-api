// The demo population's listings, shared by scripts/seed-demo-population.ts
// (which writes them) and scripts/build-demo-listing-images.ts (which finds a
// photo for each). Data only: importing this has no side effects.

// ── Listing catalogues ───────────────────────────────────────────────────────
//
// [title, category, condition, asked value (null = take the suggestion),
//  description, wanted, lookingForCategories]

export type Row = [string, string, string, number | null, string, string, string[]]

export const STANDARD: Row[] = [
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
  ["Food storage containers, set of 4", "OTHER", "LIKE_NEW", 120, "Stackable lunch containers with lids, BPA-free, used a few times.", "Kitchen stuff or plants", ["OTHER", "PLANTS"]],
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
  ["Vintage enamel soda sign", "COLLECTIBLES", "FAIR", 350, "Real vintage enamel sign, some rust at the edges.", "Other collectibles", ["COLLECTIBLES"]],
  ["Dog crate, medium", "PETS", "GOOD", 280, "Foldable wire crate with plastic tray.", "Dog food or toys", ["PETS"]],
  ["Fiddle leaf fig, 3 ft", "PLANTS", "GOOD", 200, "Healthy, repotted last month.", "Monstera or succulents", ["PLANTS"]],
  ["Casio G-Shock, black", "ACCESSORIES", "GOOD", 600, "Works perfectly, band slightly worn.", "Sunglasses or a wallet", ["ACCESSORIES"]],
  ["Hair dryer + straightener set", "BEAUTY", "GOOD", 300, "Philips, both work well.", "Skincare or makeup", ["BEAUTY"]],
  ["Bluetooth speaker, JBL Flip 5", "ELECTRONICS", "GOOD", 600, "Loud and waterproof, charges via USB-C.", "Headphones", ["ELECTRONICS", "MUSIC"]],
  ["Bookshelf, 5 tiers", "FURNITURE", "GOOD", 400, "Particle board, white, easy to assemble.", "Desk lamp or books", ["BOOKS", "FURNITURE"]],
  ["Hand-painted canvas sneakers, size 8", "CLOTHING", "LIKE_NEW", 300, "Custom painted by a local artist, worn once.", "Polo shirts or shoes", ["CLOTHING"]],
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
export const PERISHABLE: Row[] = [
  ["Ripe Guimaras mangoes", "FOOD", "NEW", 80, "Sweet carabao mangoes, picked yesterday.", "Vegetables or eggs", ["FOOD"]],
  ["Beef pares with rice, 2 servings", "FOOD", "NEW", 60, "Slow-braised this morning, packed in two containers.", "Baked goods", ["FOOD"]],
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
export const PERISHABLE_EXTRA: [number | null, "KG" | "PCS" | "LITERS" | null, 6 | 24][] = PERISHABLE.map((row, i) => {
  const unitGuess: "KG" | "PCS" | "LITERS" =
    /juice|taho/i.test(row[0]) ? "LITERS" : /kilo|mango|tuna|shrimp|crab|squash|calamansi|danggit/i.test(row[0]) ? "KG" : "PCS"
  const qty = unitGuess === "LITERS" ? 1 + (i % 2) : unitGuess === "KG" ? 1 + (i % 3) * 0.5 : [6, 10, 12, 20, 30][i % 5]
  // Most get a day; every fourth is a same-day, six-hour listing.
  const window = i % 4 === 3 ? 6 : 24
  // "Bouquet", "bundle", "tray" -- a quantity would be a lie; leave both null.
  return /bouquet|tray|garland|loaf|cake,|cake loaf|kit|servings/i.test(row[0]) ? [null, null, window] : [qty, unitGuess, window]
})

export type OrgSeed = {
  name: string
  category: string
  owner: string
  description: string
  items: Row[]
}

export const ORGS: OrgSeed[] = [
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
    description: "Women-led cooperative weaving and sewing handmade bags and home goods.",
    items: [
      ["Quilted brush roll, handmade", "ART", "NEW", 200, "Cotton quilted roll for brushes or pencils, sewn by our members.", "Sewing supplies", ["OTHER", "ART"]],
      ["Crocheted yoga mat bag", "BAGS", "NEW", 180, "Hand-crocheted cotton, fits a standard mat, adjustable strap.", "Fabric or thread", ["OTHER"]],
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
