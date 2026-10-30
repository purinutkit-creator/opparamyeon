# เอาเข้า Play Store — บันทึกความคืบหน้า

คำสั่งให้ทำต่อ: พิมพ์ **"เอาเข้าplaystore"**

## สถานะล่าสุด (30 ต.ค. 2569)

### ทำเสร็จแล้ว
- [x] เว็บพร้อมสำหรับแอป Android (TWA)
  - `public/manifest.webmanifest`: id `/pos/`, scope `/`, start `/pos/`, ภาษาไทย, ลิงก์ใส่ `?v=1180` กันแคช
  - ไอคอน `public/assets/icon-512.png`, `icon-192.png`, `icon-maskable-512.png`, `icon-maskable-192.png` (ชาม + "OPPA RAMYEON" โค้ง + แถบ "POS")
  - เส้นทาง `/.well-known/assetlinks.json` อ่านจาก env `ANDROID_PACKAGE` และ `ANDROID_SHA256` (หลายค่าคั่นด้วย ,)
  - หน้านโยบายความเป็นส่วนตัว `https://opparamyeon.onrender.com/privacy`
- [x] ตั้ง `ANDROID_PACKAGE=com.opparamyeon.pos` บน Render แล้ว
- [x] สร้างแพ็กเกจ Android ด้วย PWABuilder แล้ว (Package ID `com.opparamyeon.pos`, signing key ใหม่)
  - เจ้าของร้านได้ 2 โฟลเดอร์ (สร้าง 2 รอบ) → ตกลงใช้โฟลเดอร์ **"… Play package 2"** โฟลเดอร์เดียว
  - กุญแจ `signing.keystore` + `signing-key-info.txt` เก็บที่เครื่องเจ้าของร้าน (ห้ามส่งเข้าแชต/ห้าม commit)
- [~] สมัคร Google Play Console — กำลังทำ
  - Developer name: `Oppa Ramyeon`
  - ไม่มีเลข D-U-N-S → แนะนำให้ย้อนกลับไปเลือกบัญชีแบบ **ส่วนตัว (Yourself)** แทนองค์กร
  - หน้า "About you / Your experience" ให้ข้อความภาษาอังกฤษไปแล้ว

### ยังต้องทำ (ตามลำดับ)
1. สมัคร Play Console ให้เสร็จ (บัญชีส่วนตัว, ยืนยันตัวตน, ค่าสมัคร 25 USD)
2. รับค่า SHA-256 จาก `assetlinks.json` ในโฟลเดอร์ "Play package 2" → ตั้ง `ANDROID_SHA256` บน Render
3. Create app: `Oppa Ramyeon POS`, ภาษาไทย, App, Free
4. Store listing: คำอธิบาย, ไอคอน 512 (`icon-512.png`), feature graphic 1024×500 (ยังไม่ได้ทำ — ทำให้ได้), ภาพหน้าจอ ≥ 2 ภาพ
5. App content: privacy policy URL, Data safety (เบอร์โทร/ชื่อ/ประวัติการซื้อ, ไม่ขายข้อมูล, HTTPS, ขอลบได้), content rating, target audience 18+
6. Play App Signing → คัดลอก SHA-256 ของ "App signing key certificate" → เพิ่มต่อท้าย `ANDROID_SHA256` (คั่นด้วย ,)
7. Closed testing: อัปโหลด `.aab` + ผู้ทดสอบ ≥ 12 คน ต่อเนื่อง 14 วัน (บัญชีส่วนตัวใหม่)
8. Production release → ส่งให้ Google ตรวจ

## ค่าที่ใช้ใน PWABuilder (ไว้ใช้ถ้าต้องสร้างใหม่)
Package ID `com.opparamyeon.pos` · App name `Oppa Ramyeon POS` · Launcher `Oppa POS` · Host `opparamyeon.onrender.com` · Start URL `/pos/`
· Theme `#d4202f` · Background `#f6f5f3` · Display standalone · Version `1.0.0` / code `1`
(ถ้าสร้างใหม่ ต้องใช้ signing key เดิมจาก "Play package 2" ไม่ใช่สร้างกุญแจใหม่)
