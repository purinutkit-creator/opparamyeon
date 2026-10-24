import { db, S } from './db.js';
import { id, now } from './lib/util.js';
import { seedStaff } from './lib/auth.js';
import { DEFAULT_TEMPLATES, DOC_TYPES } from './lib/templates.js';

export async function seed({ demo = process.env.SEED_DEMO !== 'false' } = {}) {
  await seedStaff();
  if (!(await db.get('SELECT id FROM business_day_rules LIMIT 1')))
    await db.run('INSERT INTO business_day_rules(id, effective_from, cutoff, timezone, created_at) VALUES(?,?,?,?,?)', [id(), '1970-01-01', process.env.DAY_CUTOFF || '00:00', 'Asia/Bangkok', now()]);
  if (!(await db.get('SELECT id FROM templates LIMIT 1'))) await db.run("INSERT INTO settings(key, value) VALUES('seed_v11', 'true') ON CONFLICT(key) DO NOTHING");
  for (const t of Object.keys(DOC_TYPES)) if (!(await db.get('SELECT id FROM templates WHERE doc_type = ?', [t])))
    await db.run('INSERT INTO templates(id, doc_type, name, data, is_default, updated_at) VALUES(?,?,?,?,1,?)', [id(), t, 'ค่าเริ่มต้น', S(DEFAULT_TEMPLATES[t]), now()]);
  // v1.1: new kitchen-ticket style becomes the default once (existing custom templates are kept)
  if (!(await db.get("SELECT key FROM settings WHERE key = 'seed_v11'"))) {
    await db.run('UPDATE templates SET is_default = 0 WHERE doc_type = ?', ['kitchen']);
    await db.run('INSERT INTO templates(id, doc_type, name, data, is_default, updated_at) VALUES(?,?,?,?,1,?)', [id(), 'kitchen', 'ใบครัวแบบใหม่ (ตัวใหญ่)', S(DEFAULT_TEMPLATES.kitchen), now()]);
    await db.run("INSERT INTO settings(key, value) VALUES('seed_v11', 'true') ON CONFLICT(key) DO NOTHING");
  }
  if (!(await db.get('SELECT id FROM terminals LIMIT 1'))) await db.run('INSERT INTO terminals(id, name, created_at) VALUES(?,?,?)', ['pos1', 'เครื่องขาย 1', now()]);
  if (!(await db.get('SELECT id FROM tiers LIMIT 1'))) {
    const tiers = [['member', 'Member', '#64748b', 0, 0, 1, 0], ['silver', 'Silver', '#94a3b8', 150000, 5, 1.2, 0], ['gold', 'Gold', '#eab308', 500000, 15, 1.5, 5], ['vip', 'VIP', '#dc2626', 1500000, 40, 2, 10]];
    let i = 0;
    for (const [tid, name, color, spent, visits, mult, disc] of tiers) await db.run('INSERT INTO tiers(id, name, color, sort, active, min_spent, min_visits, window_days, duration_days, multiplier, discount_pct, benefits) VALUES(?,?,?,?,1,?,?,365,365,?,?,?)',
      [tid, name, color, ++i, spent, visits, mult, disc, i === 1 ? 'สะสม 1 แต้มทุก 25 บาท' : `แต้ม x${mult}` + (disc ? ` · ส่วนลด ${disc}%` : '')]);
  }
  if (!demo || (await db.get('SELECT id FROM products LIMIT 1'))) return;

  const cats = [['c_ramyeon', 'มาม่าเกาหลี', '#ef4444'], ['c_topping', 'ท็อปปิ้ง', '#f59e0b'], ['c_drink', 'เครื่องดื่ม', '#3b82f6'], ['c_snack', 'ของทานเล่น', '#10b981'], ['c_set', 'เซตเมนู', '#8b5cf6']];
  let n = 0;
  for (const [cid, name, color] of cats) await db.run('INSERT INTO categories(id, name, sort, active, color) VALUES(?,?,?,1,?)', [cid, name, ++n, color]);
  for (const [sid, name, mode, per, sort] of [['st_ramyeon', 'ครัวมาม่า', 'bowl_group', 1, 1], ['st_topping', 'จุดท็อปปิ้ง', 'order', 1, 2], ['st_drink', 'จุดเครื่องดื่ม', 'order', 1, 3]])
    await db.run('INSERT INTO stations(id, name, split_mode, bowls_per_ticket, sort) VALUES(?,?,?,?,?)', [sid, name, mode, per, sort]);
  const ing = [['i_noodle', 'มาม่าเกาหลี (ซอง)', 'ซอง', 200, 20, 2500], ['i_egg', 'ไข่ไก่', 'ฟอง', 120, 20, 400], ['i_cheese', 'ชีสแผ่น', 'แผ่น', 100, 15, 800],
    ['i_bowl', 'ภาชนะ (ชุด)', 'ชุด', 300, 30, 300], ['i_cup', 'แก้วเครื่องดื่ม', 'ใบ', 200, 30, 200], ['i_sausage', 'ไส้กรอก', 'ชิ้น', 80, 10, 700], ['i_rice_cake', 'ต๊อกบกกี', 'กรัม', 3000, 500, 3]];
  for (const [iid, name, unit, stock, low, cost] of ing) await db.run('INSERT INTO ingredients(id, name, unit, stock, low_stock, cost) VALUES(?,?,?,?,?,?)', [iid, name, unit, stock, low, cost]);
  const og = [
    ['og_noodle', 'ชนิดเส้น', 1, 1, [{ id: 'n_shin', name: 'ชินราเมียน', price: 0 }, { id: 'n_jin', name: 'จินราเมียน', price: 0 }, { id: 'n_buldak', name: 'บูลดัก', price: 1000, cost: 500 }, { id: 'n_cheese', name: 'ชีสราเมียน', price: 500 }]],
    ['og_spicy', 'ระดับความเผ็ด', 1, 1, [{ id: 's0', name: 'ไม่เผ็ด', price: 0 }, { id: 's1', name: 'เผ็ดน้อย', price: 0 }, { id: 's2', name: 'เผ็ดกลาง', price: 0 }, { id: 's3', name: 'เผ็ดมาก', price: 0 }, { id: 's4', name: 'เผ็ดนรก 🔥', price: 0 }]],
    ['og_add', 'ท็อปปิ้งเพิ่ม', 0, 5, [{ id: 'a_egg', name: 'ไข่', price: 1000, cost: 400, recipe: [{ ingredient_id: 'i_egg', qty: 1 }] }, { id: 'a_cheese', name: 'ชีส', price: 1500, cost: 800, recipe: [{ ingredient_id: 'i_cheese', qty: 1 }] },
      { id: 'a_sausage', name: 'ไส้กรอก', price: 1500, cost: 700, recipe: [{ ingredient_id: 'i_sausage', qty: 1 }] }, { id: 'a_tteok', name: 'ต๊อก', price: 2000, cost: 300, recipe: [{ ingredient_id: 'i_rice_cake', qty: 100 }] }]],
    ['og_ice', 'ความหวาน/น้ำแข็ง', 0, 1, [{ id: 'ice_normal', name: 'ปกติ', price: 0 }, { id: 'ice_less', name: 'หวานน้อย', price: 0 }, { id: 'ice_no', name: 'ไม่ใส่น้ำแข็ง', price: 0 }]],
  ];
  for (const [gid, name, min, max, options] of og) await db.run('INSERT INTO option_groups(id, name, min_select, max_select, options) VALUES(?,?,?,?,?)', [gid, name, min, max, S(options)]);
  const P = [
    // code, name, cat, price, cost, bowls, station, groups, recipe, barcode, per_bowl
    ['R001', 'มาม่าเกาหลีต้นตำรับ', 'c_ramyeon', 7900, 0, 1, 'st_ramyeon', ['og_noodle', 'og_spicy', 'og_add'], [['i_noodle', 1], ['i_bowl', 1]], '8850001000011', 2],
    ['R002', 'มาม่าชีสยืด', 'c_ramyeon', 9900, 0, 1, 'st_ramyeon', ['og_noodle', 'og_spicy', 'og_add'], [['i_noodle', 1], ['i_cheese', 2], ['i_bowl', 1]], '8850001000028', 2],
    ['R003', 'มาม่าต๊อกบกกี', 'c_ramyeon', 11900, 0, 1, 'st_ramyeon', ['og_noodle', 'og_spicy', 'og_add'], [['i_noodle', 1], ['i_rice_cake', 150], ['i_bowl', 1]], '8850001000035', 2],
    ['R004', 'เส้นมาม่าเพิ่ม (ใส่ชามเดิม)', 'c_ramyeon', 3500, 0, 1, 'st_ramyeon', [], [['i_noodle', 1]], '8850001000042', 2],
    ['T001', 'ไข่ออนเซ็น', 'c_topping', 1500, 0, 0, 'st_topping', [], [['i_egg', 1]], '8850001000103', 0],
    ['T002', 'ชีสแผ่น', 'c_topping', 1500, 0, 0, 'st_topping', [], [['i_cheese', 1]], '8850001000110', 0],
    ['T003', 'ไส้กรอก', 'c_topping', 2000, 0, 0, 'st_topping', [], [['i_sausage', 1]], '8850001000127', 0],
    ['D001', 'ชาเย็น', 'c_drink', 4500, 1200, 0, 'st_drink', ['og_ice'], [['i_cup', 1]], '8850001000202', 0],
    ['D002', 'โคล่า', 'c_drink', 2500, 1200, 0, 'st_drink', [], [], '8850001000219', 0],
    ['D003', 'น้ำเปล่า', 'c_drink', 1500, 500, 0, 'st_drink', [], [], '8850001000226', 0],
    ['S001', 'ต๊อกบกกีทอด', 'c_snack', 6900, 0, 0, 'st_topping', [], [['i_rice_cake', 150]], '8850001000301', 0],
    ['S002', 'คิมบับ', 'c_snack', 7900, 2500, 0, 'st_topping', [], [], '8850001000318', 0],
    ['SET1', 'เซตคู่รัก (มาม่า 2 ชาม + เครื่องดื่ม 2)', 'c_set', 23900, 0, 2, 'st_ramyeon', ['og_spicy'], [['i_noodle', 2], ['i_bowl', 2], ['i_cup', 2]], '8850001000400', 0],
  ];
  n = 0;
  for (const [code, name, cat, price, cost, bowls, st, groups, recipe, bc, per] of P) {
    const pid = 'p_' + code.toLowerCase();
    const rc = recipe.map(([iid, q]) => ({ ingredient_id: iid, qty: q }));
    const ingCost = rc.reduce((s, r) => s + (ing.find((x) => x[0] === r.ingredient_id)[5] * r.qty), 0);
    await db.run(`INSERT INTO products(id, code, name, category_id, price, cost, unit, bowl_count, per_bowl_limit, station_id, track_stock, stock, low_stock, active, sold_out, kind, recipe, option_groups, sort, mobile, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?,?,?,1,?)`, [pid, code, name, cat, price, cost || ingCost, code.startsWith('D') ? 'ขวด' : 'ที่', bowls, per, st,
      code === 'D002' || code === 'D003' ? 1 : 0, code === 'D002' ? 48 : code === 'D003' ? 60 : 0, 10, rc.length ? 'recipe' : 'simple', S(rc), S(groups), ++n, now()]);
    await db.run('INSERT INTO barcodes(code, product_id) VALUES(?,?)', [bc, pid]);
  }
  for (const [i, z] of [[1, 'ในร้าน'], [2, 'ในร้าน'], [3, 'ในร้าน'], [4, 'ในร้าน'], [5, 'ระเบียง'], [6, 'ระเบียง']])
    await db.run('INSERT INTO dining_tables(id, name, zone, seats, sort, active, status) VALUES(?,?,?,?,?,1,?)', ['t' + i, 'A' + i, z, i > 4 ? 4 : 2, i, 'free']);
  await db.run(`INSERT INTO rewards(id, name, description, points, product_id, tier_ids, total_limit, per_member_limit, coupon_days, active, issued_count, return_policy, terms, cost)
    VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?)`, ['rw_egg', 'ไข่ออนเซ็นฟรี 1 ฟอง', 'ใช้แต้มแลกไข่ออนเซ็น', 20, 'p_t001', '[]', 0, 0, 7, 'refund_points', 'ใช้ได้ 1 ครั้ง ภายใน 7 วันหลังแลก', 400]);
  await db.run(`INSERT INTO rewards(id, name, description, points, product_id, tier_ids, total_limit, per_member_limit, coupon_days, active, issued_count, return_policy, terms, cost)
    VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?)`, ['rw_ramyeon', 'มาม่าเกาหลีต้นตำรับฟรี', 'เฉพาะ Gold และ VIP', 120, 'p_r001', '["gold","vip"]', 100, 2, 14, 'refund_points', 'จำกัด 2 สิทธิ์ต่อสมาชิก', 2800]);
}
