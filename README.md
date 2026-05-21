# 🛒 GroceryDesk v2 — Phase 2 Production Upgrade

A secure, multi-user grocery and household indent management platform with role-based access control, workflow governance, interactive drill-down analytics, and audit logging.

---

## 📁 File Structure

```
GroceryDesk-v2/
├── index.html              ← Complete frontend (single-file app)
├── google-apps-script.js   ← Backend API (paste into Apps Script editor)
├── sw.js                   ← Service Worker (PWA offline caching)
├── manifest.json           ← PWA manifest
└── README.md               ← This file
```

---

## 🆕 What's New in Phase 2

| Feature | Status |
|---|---|
| Role-Based Access Control (Admin / User) | ✅ |
| Admin password authentication (SHA-256) | ✅ |
| Session-based admin tokens (8hr expiry) | ✅ |
| Status workflow engine (Open → ... → Closed) | ✅ |
| Closed status = permanent lock | ✅ |
| User can only edit Open records | ✅ |
| Admin-only status changes (frontend + backend) | ✅ |
| Category auto-fetch from Items sheet | ✅ |
| Case-insensitive item matching | ✅ |
| Duplicate item prevention | ✅ |
| AuditLogs sheet (full trail) | ✅ |
| LastUpdated timestamp tracking | ✅ |
| Interactive drill-down on all charts & cards | ✅ |
| Date/period filter bar (Today/Week/Month/Custom) | ✅ |
| Dark / Light mode | ✅ |
| PWA / offline support | ✅ |
| CSV export (filtered) | ✅ |
| Admin panel with analytics | ✅ |
| Audit log viewer | ✅ |
| Admin password change UI | ✅ |
| Input sanitization (XSS prevention) | ✅ |
| Backend role validation on all writes | ✅ |

---

## 🗄️ Google Sheets Schema

### Sheet 1: `GroceryDesk Database`

| Col | Header | Type | Notes |
|-----|--------|------|-------|
| A | RecordID | String | Auto-generated (IND-XXXXX) |
| B | UserName | String | Name of requestor |
| C | ItemName | String | Auto-normalized |
| D | Category | String | Auto-fetched from Items sheet |
| E | Quantity | Number | Validated > 0 |
| F | Unit | String | From dropdown |
| G | Urgency | String | Immediately / Today / This Week / … |
| H | Status | String | Always starts as **Open** |
| I | Remarks | String | Optional notes |
| J | CreatedDate | String | Date of submission |
| K | LastUpdated | ISO String | Updated on every change |
| L | UpdatedBy | String | UserName or "Admin" |

### Sheet 2: `Items`

| Col | Header | Notes |
|-----|--------|-------|
| A | ItemName | Case-normalized, deduplicated |
| B | Category | From the 29-category list |

### Sheet 3: `Users`

| Col | Header | Notes |
|-----|--------|-------|
| A | UserName | Auto-registered on first indent |
| B | Role | user / admin |
| C | CreatedDate | First seen |
| D | LastSeen | Updated on each interaction |

### Sheet 4: `AuditLogs`

| Col | Header | Notes |
|-----|--------|-------|
| A | LogID | Auto-generated (LOG-XXXXX) |
| B | RecordID | Which record was affected |
| C | ActionType | CREATE / UPDATE / STATUS_CHANGE / LOGIN |
| D | ModifiedBy | UserName or Admin |
| E | OldValue | Previous value (JSON for edits) |
| F | NewValue | New value |
| G | Timestamp | ISO timestamp |
| H | UserRole | user / admin |
| I | Notes | Human-readable description |

### Sheet 5: `Settings`

| Col | Header | Notes |
|-----|--------|-------|
| A | Key | Setting name |
| B | Value | Setting value |
| C | UpdatedAt | When last changed |

**Default settings written automatically:**
- `adminPasswordHash` — SHA-256 of the admin password
- `adminSessions` — JSON array of active session tokens
- `appVersion` — 2.0.0

---

## 🔄 Status Workflow

```
                        ┌──────────────┐
                        │     Open     │  ← All new indents start here
                        └──────┬───────┘
                               │ Admin only
          ┌────────────────────┼────────────────────────┐
          ▼                    ▼                        ▼
    In Progress           Postponed           Reserved for Future
          │                    │                        │
          │            ┌───────┴───────┐                │
          └────────────►    Ordered    ◄────────────────┘
                        └──────┬───────┘
                               │          ┌────────────┐
                Recheck ───────┤          │  Rejected  │
                               │          └─────┬──────┘
                               │                │
                        ┌──────▼────────────────▼──────┐
                        │           Closed             │  ← PERMANENT LOCK
                        └──────────────────────────────┘
```

**Rules:**
- `Open` → any intermediate status (admin only)
- `Ordered` → `Closed` only (admin only)
- `Rejected` → `Closed` only (admin only)
- `Closed` → **NOTHING** — locked forever, even for admin

---

## 🔐 Security Architecture

### Authentication Flow
```
Frontend                          Apps Script Backend
   │                                     │
   │  1. User enters password             │
   │  2. SHA-256 hash computed (client)   │
   │─────── POST /adminLogin ────────────►│
   │         { passwordHash: "abc..." }   │
   │                                     │  3. Compare hash with stored hash
   │                                     │  4. Generate session token (UUID)
   │◄────── { token, expiresAt } ────────│  5. Store token in Settings sheet
   │                                     │
   │  6. Token stored in sessionStorage  │
   │                                     │
   │─────── POST /updateStatus ──────────►│
   │   adminToken=TOKEN in query string   │  7. verifyAdmin(token) → check expiry
   │                                     │  8. Validate workflow transition
   │◄────── { status: ok } ─────────────│  9. Write + audit log
```

### What Is Protected
| Action | User | Admin |
|--------|------|-------|
| Create indent | ✅ | ✅ |
| View own orders | ✅ | ✅ |
| Edit own Open request | ✅ | ✅ |
| Edit non-Open request | ❌ | ✅ |
| Change status | ❌ | ✅ |
| Access Admin Panel | ❌ | ✅ |
| Access Audit Logs | ❌ | ✅ |
| Access Setup & Help | ❌ | ✅ |
| Modify Closed record | ❌ | ❌ |

### Backend Enforcement
Every admin action in `google-apps-script.js` calls `verifyAdmin(token)` before proceeding. This cannot be bypassed by frontend manipulation.

---

## 🚀 Deployment Guide (Beginner-Friendly)

### PHASE 1 — Google Sheets

**Step 1: Create Spreadsheet**
1. Go to [sheets.google.com](https://sheets.google.com)
2. Click **+ Blank**
3. Name it: `GroceryDesk Database`
4. You'll need these 5 sheet tabs (the script creates them, but you can pre-create):
   - `GroceryDesk Database`
   - `Items`
   - `Users`
   - `AuditLogs`
   - `Settings`

**Step 2: Note the Spreadsheet ID**
From the URL bar: `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`
Copy the long ID string.

---

### PHASE 2 — Apps Script Backend

**Step 3: Open Apps Script**
In your spreadsheet: **Extensions → Apps Script**

**Step 4: Paste the Backend**
- Delete all existing code
- Copy the entire contents of `google-apps-script.js`
- Paste it in the editor
- Press **Ctrl+S** to save

**Step 5: Set Your Spreadsheet ID**
Find this line near the top and replace the placeholder:
```javascript
var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
// Replace with your actual ID, e.g.:
var SPREADSHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms';
```

**Step 6: Initialize Everything**
1. In the function dropdown (top of editor), select **`initializeSheets`**
2. Click ▶ **Run**
3. **Authorize permissions** when prompted:
   - Click "Review permissions"
   - Choose your Google account
   - Click "Advanced" → "Go to GroceryDesk (unsafe)"
   - Click "Allow"
4. Check the execution log — should say "✅ All sheets initialized successfully!"

**Step 7: Seed Item Master**
1. Select **`seedItems`** from the dropdown
2. Click ▶ **Run**
3. This adds 80+ pre-categorized items to your Items sheet

**Step 8: Verify Setup**
1. Select **`runSelfTest`** → Run
2. Check the log output for any errors

---

### PHASE 3 — Deploy as Web App

**Step 9: Deploy**
1. Click **Deploy** (top right) → **New deployment**
2. Click ⚙️ gear icon → Select **Web App**
3. Configure:
   - Description: `GroceryDesk v2`
   - Execute as: **Me** (your Google account)
   - Who has access: **Anyone**
4. Click **Deploy**
5. Authorize again if prompted

**Step 10: Copy the Web App URL**
After deployment you'll see something like:
```
https://script.google.com/macros/s/AKfycbXXXXXXXXXXXXXXXXX/exec
```
**Copy this URL — you'll need it in the next step.**

> ⚠️ **Important:** Every time you change the Apps Script code, you must create a **New Deployment** (not redeploy the same one). Old URLs remain functional.

---

### PHASE 4 — Connect Frontend

**Step 11: Open the App**
Open `index.html` in a web browser (just double-click, or host it somewhere).

**Step 12: Admin Login**
1. Click **Admin Login** in the sidebar
2. Default password: **`GroceryDesk@Admin2024`**
3. After login you'll see Admin Panel, Audit Logs, Setup & Help

**Step 13: Paste Apps Script URL**
1. Go to **Setup & Help** in the sidebar
2. Paste your Web App URL in the configuration field
3. Click **Test Connection** — should show "✓ Connected!"

**Step 14: Change Admin Password**
1. Still on Setup & Help page
2. Scroll to "Admin Password" section
3. Enter and confirm a new strong password
4. Click **Change Password**
5. Log in again with your new password

---

### PHASE 5 — Host the Frontend

**Option A: GitHub Pages (Free, Recommended)**
```bash
# 1. Create repo at github.com (e.g. "grocerydesk")
# 2. Upload index.html, sw.js, manifest.json
# 3. Settings → Pages → Source: main branch → Save
# URL: https://yourusername.github.io/grocerydesk
```

**Option B: Netlify Drop (Fastest)**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the entire `GroceryDesk-v2` folder
3. Instantly live at a random `.netlify.app` URL

**Option C: Local Use**
Just open `index.html` directly — works perfectly for personal/family use.

---

## ⚠️ Important Notes After Deployment

### Redeployment Rule
After **any code change** in Apps Script:
1. Click Deploy → **New Deployment** (NOT "Manage deployments → Edit")
2. Type: Web App, same settings
3. Copy the **new URL** and update it in Setup & Help

### Admin Token Expiry
Admin sessions expire after **8 hours** automatically. You'll be prompted to log in again.

### Rate Limits
- Free Google accounts: ~20,000 requests/day
- Google Workspace: ~100,000 requests/day
- Each page load = 1–3 API calls

---

## 🔒 Security Best Practices

1. **Change default password immediately** after first deployment
2. **Use a strong password** (12+ chars, mixed case, numbers, symbols)
3. **Never share** your Apps Script URL in public repositories
4. **Keep the Spreadsheet** on "Restricted" sharing — the script accesses it as you
5. **Monitor AuditLogs** regularly for suspicious activity
6. **Token rotation**: Admin sessions auto-expire in 8 hours
7. **Input sanitization**: All inputs stripped of HTML/injection characters server-side
8. **HTTPS**: Google Apps Script enforces HTTPS — data in transit is encrypted

### Optional: Token-Based API Protection
Add a secret token layer (recommended for production):
```javascript
// In google-apps-script.js, add at top of doGet and doPost:
var API_SECRET = 'your-random-secret-string-here';
if (p.secret !== API_SECRET) return err('Unauthorized');

// In frontend, add to all API calls:
url.searchParams.set('secret', 'your-random-secret-string-here');
```

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| "Apps Script URL not configured" | Go to Setup & Help, paste your Web App URL |
| "Connection failed" | Check URL ends in `/exec`, redeploy if needed |
| Admin login rejected | Run `resetAdminPasswordToDefault()` in Apps Script editor |
| Categories not auto-filling | Run `seedItems()` to populate Items sheet |
| Status not changing | Ensure you're logged in as Admin |
| Old data not showing | Click "Refresh" / reload the dashboard |
| "Invalid transition" error | Check the status workflow diagram above |
| Script authorization error | Re-run `initializeSheets()` and re-authorize |

---

## 📈 Scalability Roadmap

| Scale | Solution |
|-------|----------|
| > 10,000 records | Add server-side pagination via `limit` + `offset` params |
| > 50,000 records | Migrate to BigQuery or Firebase Firestore |
| Multiple admins | Add per-admin credentials to Users sheet |
| Email notifications | Uncomment GmailApp code in Apps Script |
| WhatsApp alerts | Integrate Twilio/WhatsApp Business API |
| Barcode scanning | Add `quagga.js` to frontend |
| Voice entry | Use Web Speech API (`window.SpeechRecognition`) |
| Budget tracking | Add `Price` column, aggregate in dashboard |
| Inventory levels | Add `StockLevel` to Items sheet, deduct on Order |
| Google Looker Studio | Connect your Sheet directly for advanced BI dashboards |
| Multi-language | Add `lang` setting, use i18n object for labels |

---

## 🆚 Phase 1 vs Phase 2 Comparison

| Feature | Phase 1 | Phase 2 |
|---------|---------|---------|
| Status values | 6 (no Open/Closed) | 8 (Open + Closed added) |
| Default status on create | In Progress | **Open** (enforced) |
| Status changes | Any user | **Admin only** |
| Closed status | None | **Permanent lock** |
| Admin auth | None | **SHA-256 + session token** |
| Category auto-fetch | Partial | **Full (case-insensitive)** |
| Audit logs | None | **Complete trail** |
| Date filter | None | **Today/Week/Month/Custom** |
| Drill-down | None | **Click any chart/card** |
| Backend role validation | None | **All writes validated** |
| Edit restrictions | None | **Open only for users** |

---

*GroceryDesk v2 — Built for households and small teams. Phase 2 Production Upgrade.*
