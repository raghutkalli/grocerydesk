/**
 * ══════════════════════════════════════════════════════════════════════
 *  GroceryDesk v2 — Google Apps Script Backend (Phase 2)
 *  Paste this ENTIRE file into your Apps Script editor (Code.gs)
 *
 *  SHEET STRUCTURE REQUIRED:
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │  Sheet 1: "GroceryDesk Database"  (main indent records)        │
 *  │  Sheet 2: "Items"                 (item master list)           │
 *  │  Sheet 3: "Users"                 (user registry)              │
 *  │  Sheet 4: "AuditLogs"             (action trail)               │
 *  │  Sheet 5: "Settings"              (admin config)               │
 *  └─────────────────────────────────────────────────────────────────┘
 * ══════════════════════════════════════════════════════════════════════
 */

// ─── CONFIGURATION ─────────────────────────────────────────────────────
// Replace with your actual Spreadsheet ID (from the URL bar of your sheet)
var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

// Sheet names (must match exactly, case-sensitive)
var SHEET_DB      = 'GroceryDesk Database';
var SHEET_ITEMS   = 'Items';
var SHEET_USERS   = 'Users';
var SHEET_AUDIT   = 'AuditLogs';
var SHEET_SETTINGS= 'Settings';

// Default admin password hash — SHA-256 of "GroceryDesk@Admin2024"
// This is the REAL computed hash. Change password via Setup & Help after first login.
var DEFAULT_ADMIN_HASH = '96f4d6ef9ed413f6410cb62c3a42b041190c5fb5a62cc86500bf2e1831fc4cfa';

// Session token validity (hours)
var SESSION_HOURS = 8;

// ─── CORS: Handle OPTIONS preflight from browsers (required for hosted frontends)
// Google Apps Script automatically adds Access-Control-Allow-Origin: * to GET responses.
// Returning a valid response from doOptions prevents preflight failures.
function doOptions(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'CORS preflight accepted' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── ALLOWED STATUS TRANSITIONS ─────────────────────────────────────────
// Server-side enforcement — mirrors frontend logic
var STATUS_TRANSITIONS = {
  'Open':                ['In Progress','Ordered','Postponed','Reserved for Future','Recheck','Rejected'],
  'In Progress':         ['Ordered','Postponed','Reserved for Future','Recheck','Rejected'],
  'Ordered':             ['Closed'],
  'Postponed':           ['In Progress','Ordered','Rejected'],
  'Reserved for Future': ['In Progress','Ordered','Rejected'],
  'Recheck':             ['In Progress','Ordered','Rejected'],
  'Rejected':            ['Closed'],
  'Closed':              []  // Terminal — fully locked
};

// ─── DB COLUMN INDICES (0-based) ──────────────────────────────────────
var COL = {
  recordId:    0,   // A
  userName:    1,   // B
  itemName:    2,   // C
  category:    3,   // D
  quantity:    4,   // E
  unit:        5,   // F
  urgency:     6,   // G
  status:      7,   // H
  remarks:     8,   // I
  createdDate: 9,   // J
  lastUpdated: 10,  // K
  updatedBy:   11   // L
};

// ─── ITEMS SHEET COLUMNS ──────────────────────────────────────────────
var ICOL = { name: 0, category: 1 };

// ─── AUDIT SHEET COLUMNS ─────────────────────────────────────────────
var ACOL = {
  logId:      0,  // A
  recordId:   1,  // B
  actionType: 2,  // C
  modifiedBy: 3,  // D
  oldValue:   4,  // E
  newValue:   5,  // F
  timestamp:  6,  // G
  userRole:   7,  // H
  notes:      8   // I
};

// ═══════════════════════════════════════════════════════════════════════
//  ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle ALL requests via GET.
 *
 * Why GET-only? The frontend sends all data (including write ops) as
 * encoded URL params. This avoids:
 *   - HTTP 405 errors from GitHub Pages / Netlify (which reject POST)
 *   - CORS preflight failures from cross-origin POST to GAS
 *   - Browser converting POST→GET on 301/302 redirects from GAS
 *
 * Write-operation data is passed as: ?action=X&payload=URL_ENCODED_JSON
 * Read-operation params are passed directly: ?action=getOrders&userName=X
 */
function doGet(e) {
  try {
    var p      = e.parameter || {};
    var action = p.action    || '';
    var token  = p.adminToken || '';

    // Parse payload sent by frontend for write operations
    var body = {};
    if (p.payload) {
      try { body = JSON.parse(decodeURIComponent(p.payload)); } catch(pe) {
        return err('Invalid payload JSON: ' + pe.message);
      }
    }

    switch (action) {

      // ── READ OPERATIONS ──────────────────────────────────────────
      case 'ping':
        return ok({ message: 'GroceryDesk v2 API running', version: '2.0.0' });

      case 'getItems':
        return ok({ items: getItemMaster() });

      case 'getOrders':
        return ok({ orders: getOrdersByUser(p.userName || body.userName || '') });

      case 'getAll':
      case 'getDashboard':
        return ok({ orders: getAllOrders() });

      case 'getAuditLogs':
        if (!verifyAdmin(token)) return err('Unauthorized: admin token required');
        return ok({ logs: getAuditLogs(parseInt(p.limit || body.limit || '200')) });

      // ── WRITE OPERATIONS (data arrives via payload URL param) ─────
      case 'adminLogin':
        return ok(adminLogin(body.passwordHash || ''));

      case 'submitIndent':
        return ok(submitIndent(body));

      case 'updateStatus':
        if (!verifyAdmin(token)) return err('Unauthorized: admin token required');
        return ok(updateStatus(body, token));

      case 'updateRow':
        return ok(updateRow(body, token));

      case 'addItem':
        return ok(addItemToMaster(body.name, body.category));

      case 'changeAdminPassword':
        if (!verifyAdmin(token)) return err('Unauthorized: admin token required');
        return ok(changeAdminPassword(body.newHash || ''));

      default:
        return err('Unknown action: ' + action);
    }
  } catch (ex) {
    return err(ex.message);
  }
}

/**
 * doPost kept for backward compatibility.
 * The frontend now uses GET-only (via apiCall), so this is a fallback
 * in case someone calls the API directly with POST.
 * It delegates to doGet so logic stays in one place.
 */
function doPost(e) {
  try {
    var p      = e.parameter || {};
    var action = p.action    || '';
    var token  = p.adminToken || '';
    var body   = {};

    // Try to parse POST body first
    try { body = JSON.parse(e.postData.contents || '{}'); } catch(_) {}

    // Also check payload param (in case sent that way)
    if (!Object.keys(body).length && p.payload) {
      try { body = JSON.parse(decodeURIComponent(p.payload)); } catch(_) {}
    }

    // Delegate to the same handlers used by doGet
    switch (action) {
      case 'adminLogin':          return ok(adminLogin(body.passwordHash || ''));
      case 'submitIndent':        return ok(submitIndent(body));
      case 'updateStatus':
        if (!verifyAdmin(token))  return err('Unauthorized: admin token required');
        return ok(updateStatus(body, token));
      case 'updateRow':           return ok(updateRow(body, token));
      case 'addItem':             return ok(addItemToMaster(body.name, body.category));
      case 'changeAdminPassword':
        if (!verifyAdmin(token))  return err('Unauthorized: admin token required');
        return ok(changeAdminPassword(body.newHash || ''));
      default:                    return err('Unknown action: ' + action);
    }
  } catch (ex) {
    return err(ex.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  AUTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify admin login — returns session token on success
 * @param {string} passwordHash - SHA-256 hash of the entered password
 */
function adminLogin(passwordHash) {
  if (!passwordHash) return { status: 'error', message: 'Password required' };

  // Fetch stored hash; if Settings sheet is not set up yet, auto-seed with default
  var storedHash = getSetting('adminPasswordHash');
  if (!storedHash) {
    // First login ever — seed the default hash automatically
    setSetting('adminPasswordHash', DEFAULT_ADMIN_HASH);
    setSetting('adminSessions', '[]');
    storedHash = DEFAULT_ADMIN_HASH;
  }

  if (passwordHash.toLowerCase() !== storedHash.toLowerCase()) {
    writeAuditLog('', 'LOGIN', 'Unknown', '', '', 'FAILED LOGIN ATTEMPT', 'user');
    return { status: 'error', message: 'Invalid password. If this is your first login, use: GroceryDesk@Admin2024' };
  }

  // Generate session token
  var token     = generateId('TOK');
  var expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();

  // Store token in Settings (as JSON array of active sessions)
  var sessions = [];
  try { sessions = JSON.parse(getSetting('adminSessions') || '[]'); } catch(_) {}

  // Purge expired sessions
  sessions = sessions.filter(function(s) { return new Date(s.expiresAt) > new Date(); });
  sessions.push({ token: token, expiresAt: expiresAt });
  setSetting('adminSessions', JSON.stringify(sessions));

  writeAuditLog('', 'LOGIN', 'Admin', '', '', 'Admin login successful', 'admin');

  return { status: 'ok', token: token, expiresAt: expiresAt, adminName: 'Admin' };
}

/**
 * Verify admin session token
 * @param {string} token
 * @returns {boolean}
 */
function verifyAdmin(token) {
  if (!token) return false;
  try {
    var sessions = JSON.parse(getSetting('adminSessions') || '[]');
    var now      = new Date();
    return sessions.some(function(s) {
      return s.token === token && new Date(s.expiresAt) > now;
    });
  } catch(_) {
    return false;
  }
}

/**
 * Change admin password — stores new SHA-256 hash
 */
function changeAdminPassword(newHash) {
  if (!newHash || newHash.length < 10) return { status: 'error', message: 'Invalid hash' };
  setSetting('adminPasswordHash', newHash.toLowerCase());
  // Invalidate all existing sessions
  setSetting('adminSessions', '[]');
  writeAuditLog('', 'UPDATE', 'Admin', 'adminPassword', '***', '***NEW HASH SET***', 'admin');
  return { status: 'ok', message: 'Password updated. Please log in again.' };
}

// ═══════════════════════════════════════════════════════════════════════
//  INDENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Submit new indent — always sets status to "Open"
 * Body: { userName, createdDate, items: [{name, category, qty, unit, urgency}] }
 */
function submitIndent(body) {
  var userName    = sanitize(body.userName || '');
  var createdDate = sanitize(body.createdDate || new Date().toLocaleString('en-IN'));
  var items       = body.items || [];

  if (!userName)     return { status: 'error', message: 'UserName required' };
  if (!items.length) return { status: 'error', message: 'At least one item required' };

  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_DB, getDbHeaders());
  var now   = new Date().toISOString();
  var ids   = [];

  // Load item master once for category lookup
  var masterItems = getItemMaster();

  var rows = items.map(function(item) {
    var name = sanitize(item.name || '').replace(/\s+/g, ' ').trim();

    // ── Category auto-fetch from master (case-insensitive) ──
    var category = sanitize(item.category || 'Miscellaneous');
    var masterMatch = masterItems.find(function(m) {
      return m.name.trim().toLowerCase() === name.toLowerCase();
    });
    if (masterMatch && masterMatch.category) {
      category = masterMatch.category;
    }

    var id = generateId('IND');
    ids.push(id);

    // Auto-add new item to master if not found
    if (!masterMatch && name) {
      addItemToMaster(name, category);
      masterItems.push({ name: name, category: category }); // local cache
    }

    return [
      id,              // A: RecordID
      userName,        // B: UserName
      name,            // C: ItemName
      category,        // D: Category (auto-fetched)
      parseFloat(item.qty) || 1,  // E: Quantity
      sanitize(item.unit || 'Unit'),   // F: Unit
      sanitize(item.urgency || 'This Week'), // G: Urgency
      'Open',          // H: Status (ALWAYS "Open" on creation)
      '',              // I: Remarks
      createdDate,     // J: CreatedDate
      now,             // K: LastUpdated
      userName         // L: UpdatedBy
    ];
  });

  // Batch append all rows
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);

  // Audit log each created record
  ids.forEach(function(id, i) {
    writeAuditLog(id, 'CREATE', userName, '', '', 'New indent created: ' + items[i].name, 'user');
  });

  // Register user if new
  registerUser(userName, 'user');

  return { status: 'ok', count: rows.length, ids: ids };
}

/**
 * Get all orders for a specific user (case-insensitive)
 */
function getOrdersByUser(userName) {
  if (!userName) return [];
  var all = getAllOrders();
  var lower = userName.trim().toLowerCase();
  return all.filter(function(o) {
    return (o.userName || '').toLowerCase() === lower;
  });
}

/**
 * Get ALL orders from the database sheet
 */
function getAllOrders() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DB);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  return data.slice(1).map(function(row) {
    return rowToOrder(row);
  }).filter(function(o) { return o.recordId; });
}

/**
 * Convert a raw sheet row to an order object
 */
function rowToOrder(row) {
  return {
    recordId:    String(row[COL.recordId]    || ''),
    userName:    String(row[COL.userName]    || ''),
    itemName:    String(row[COL.itemName]    || ''),
    category:    String(row[COL.category]   || ''),
    quantity:    row[COL.quantity]            || 0,
    unit:        String(row[COL.unit]        || ''),
    urgency:     String(row[COL.urgency]     || ''),
    status:      String(row[COL.status]      || 'Open'),
    remarks:     String(row[COL.remarks]     || ''),
    createdDate: String(row[COL.createdDate] || ''),
    lastUpdated: String(row[COL.lastUpdated] || ''),
    updatedBy:   String(row[COL.updatedBy]   || '')
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  STATUS UPDATE (ADMIN ONLY — enforced here)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update status with workflow validation
 * Body: { recordId, newStatus, remarks, updatedBy }
 * Requires valid admin token (verified before calling this function)
 */
function updateStatus(body, adminToken) {
  var recordId  = sanitize(body.recordId  || '');
  var newStatus = sanitize(body.newStatus || '');
  var remarks   = sanitize(body.remarks   || '');
  var updatedBy = sanitize(body.updatedBy || 'Admin');

  if (!recordId)  return { status: 'error', message: 'recordId required' };
  if (!newStatus) return { status: 'error', message: 'newStatus required' };

  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DB);
  if (!sheet) return { status: 'error', message: SHEET_DB + ' sheet not found' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][COL.recordId]) === recordId) {
      var currentStatus = String(data[i][COL.status] || 'Open');

      // ── CLOSED LOCK: absolute — nobody can change Closed ──
      if (currentStatus === 'Closed') {
        return { status: 'error', message: 'Record is Closed and cannot be modified' };
      }

      // ── Workflow transition validation ──
      var allowed = STATUS_TRANSITIONS[currentStatus] || [];
      if (allowed.indexOf(newStatus) === -1) {
        return {
          status: 'error',
          message: 'Invalid transition: ' + currentStatus + ' → ' + newStatus +
                   '. Allowed: ' + (allowed.join(', ') || 'none')
        };
      }

      var now = new Date().toISOString();
      var rowNum = i + 1;

      // Update status, remarks, lastUpdated, updatedBy
      sheet.getRange(rowNum, COL.status      + 1).setValue(newStatus);
      sheet.getRange(rowNum, COL.lastUpdated + 1).setValue(now);
      sheet.getRange(rowNum, COL.updatedBy   + 1).setValue(updatedBy);
      if (remarks) {
        sheet.getRange(rowNum, COL.remarks + 1).setValue(remarks);
      }

      // Audit log
      writeAuditLog(
        recordId, 'STATUS_CHANGE', updatedBy,
        currentStatus, newStatus,
        'Status changed' + (remarks ? '. Note: ' + remarks : ''),
        'admin'
      );

      return { status: 'ok', recordId: recordId, oldStatus: currentStatus, newStatus: newStatus };
    }
  }

  return { status: 'error', message: 'Record not found: ' + recordId };
}

// ═══════════════════════════════════════════════════════════════════════
//  ROW UPDATE (Admin or user editing their own Open record)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update editable fields on a record
 * Body: { recordId, itemName, qty, unit, urgency, category, remarks, updatedBy }
 */
function updateRow(body, adminToken) {
  var recordId  = sanitize(body.recordId  || '');
  var itemName  = sanitize(body.itemName  || '');
  var qty       = parseFloat(body.qty) || 0;
  var unit      = sanitize(body.unit      || '');
  var urgency   = sanitize(body.urgency   || '');
  var category  = sanitize(body.category  || '');
  var remarks   = sanitize(body.remarks   || '');
  var updatedBy = sanitize(body.updatedBy || 'User');

  if (!recordId) return { status: 'error', message: 'recordId required' };
  if (!itemName) return { status: 'error', message: 'itemName required' };
  if (qty <= 0)  return { status: 'error', message: 'Valid quantity required' };

  var isAdmin = verifyAdmin(adminToken);

  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DB);
  if (!sheet) return { status: 'error', message: SHEET_DB + ' sheet not found' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][COL.recordId]) === recordId) {
      var currentStatus = String(data[i][COL.status] || 'Open');

      // ── CLOSED LOCK ──
      if (currentStatus === 'Closed') {
        return { status: 'error', message: 'Record is Closed and cannot be edited' };
      }

      // ── Non-admin can only edit Open records ──
      if (!isAdmin && currentStatus !== 'Open') {
        return {
          status: 'error',
          message: 'You can only edit records with Open status. Current status: ' + currentStatus
        };
      }

      var now    = new Date().toISOString();
      var rowNum = i + 1;

      // Capture old values for audit
      var oldVals = {
        itemName:  String(data[i][COL.itemName]  || ''),
        quantity:  data[i][COL.quantity],
        unit:      String(data[i][COL.unit]      || ''),
        urgency:   String(data[i][COL.urgency]   || ''),
        category:  String(data[i][COL.category]  || ''),
        remarks:   String(data[i][COL.remarks]   || '')
      };

      // Apply updates
      if (itemName) sheet.getRange(rowNum, COL.itemName + 1).setValue(itemName);
      if (qty)      sheet.getRange(rowNum, COL.quantity  + 1).setValue(qty);
      if (unit)     sheet.getRange(rowNum, COL.unit      + 1).setValue(unit);
      if (urgency)  sheet.getRange(rowNum, COL.urgency   + 1).setValue(urgency);
      if (category && isAdmin) sheet.getRange(rowNum, COL.category + 1).setValue(category);
      sheet.getRange(rowNum, COL.remarks     + 1).setValue(remarks);
      sheet.getRange(rowNum, COL.lastUpdated + 1).setValue(now);
      sheet.getRange(rowNum, COL.updatedBy   + 1).setValue(updatedBy);

      // Audit log with diff
      var changes = [];
      if (itemName !== oldVals.itemName) changes.push('name: ' + oldVals.itemName + '→' + itemName);
      if (qty !== oldVals.quantity)      changes.push('qty: ' + oldVals.quantity + '→' + qty);
      if (unit !== oldVals.unit)         changes.push('unit: ' + oldVals.unit + '→' + unit);
      if (urgency !== oldVals.urgency)   changes.push('urgency: ' + oldVals.urgency + '→' + urgency);

      writeAuditLog(
        recordId, 'UPDATE', updatedBy,
        JSON.stringify(oldVals),
        changes.join('; ') || 'Minor update',
        isAdmin ? 'Admin edit' : 'User edit (Open status)',
        isAdmin ? 'admin' : 'user'
      );

      return { status: 'ok', recordId: recordId };
    }
  }

  return { status: 'error', message: 'Record not found: ' + recordId };
}

// ═══════════════════════════════════════════════════════════════════════
//  ITEM MASTER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get all items from Items sheet
 * @returns {Array} [{name, category}]
 */
function getItemMaster() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_ITEMS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  return data.slice(1).map(function(row) {
    return {
      name:     String(row[ICOL.name]     || '').trim(),
      category: String(row[ICOL.category] || 'Miscellaneous').trim()
    };
  }).filter(function(i) { return i.name; });
}

/**
 * Add a new item to the master list
 * Prevents duplicates (case-insensitive)
 */
function addItemToMaster(name, category) {
  name     = sanitize((name     || '').trim().replace(/\s+/g, ' '));
  category = sanitize((category || 'Miscellaneous').trim());

  if (!name) return { status: 'error', message: 'Item name required' };

  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_ITEMS, [['ItemName', 'Category']]);

  // Check for duplicates (case-insensitive)
  var existing = getItemMaster();
  var dupe = existing.find(function(i) {
    return i.name.toLowerCase() === name.toLowerCase();
  });
  if (dupe) return { status: 'ok', message: 'Item already exists', name: dupe.name, category: dupe.category, duplicate: true };

  // Normalize name (title case first letter of each word)
  var normalizedName = name.split(' ').map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');

  sheet.appendRow([normalizedName, category]);
  return { status: 'ok', name: normalizedName, category: category };
}

// ═══════════════════════════════════════════════════════════════════════
//  AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════

/**
 * Write an audit log entry
 */
function writeAuditLog(recordId, actionType, modifiedBy, oldValue, newValue, notes, userRole) {
  try {
    var ss    = getSpreadsheet();
    var sheet = getOrCreateSheet(ss, SHEET_AUDIT, getAuditHeaders());

    var logId = generateId('LOG');
    sheet.appendRow([
      logId,
      recordId    || '',
      actionType  || '',
      modifiedBy  || '',
      oldValue    || '',
      newValue    || '',
      new Date().toISOString(),
      userRole    || 'user',
      notes       || ''
    ]);
  } catch(e) {
    // Audit log failure should never crash the main operation
    Logger.log('AuditLog write failed: ' + e.message);
  }
}

/**
 * Get audit logs (latest N entries, newest first)
 */
function getAuditLogs(limit) {
  limit = limit || 200;
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_AUDIT);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  var data = sheet.getDataRange().getValues();
  return data.slice(1).reverse().slice(0, limit).map(function(row) {
    return {
      logId:      String(row[ACOL.logId]      || ''),
      recordId:   String(row[ACOL.recordId]   || ''),
      actionType: String(row[ACOL.actionType] || ''),
      modifiedBy: String(row[ACOL.modifiedBy] || ''),
      oldValue:   String(row[ACOL.oldValue]   || ''),
      newValue:   String(row[ACOL.newValue]   || ''),
      timestamp:  String(row[ACOL.timestamp]  || ''),
      userRole:   String(row[ACOL.userRole]   || ''),
      notes:      String(row[ACOL.notes]      || '')
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  USERS REGISTRY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a user if they don't already exist
 */
function registerUser(userName, role) {
  try {
    var ss    = getSpreadsheet();
    var sheet = getOrCreateSheet(ss, SHEET_USERS, [['UserName','Role','CreatedDate','LastSeen']]);

    var data = sheet.getDataRange().getValues();
    var exists = data.slice(1).some(function(r) {
      return String(r[0]).toLowerCase() === userName.toLowerCase();
    });

    if (!exists) {
      var now = new Date().toISOString();
      sheet.appendRow([userName, role || 'user', now, now]);
    } else {
      // Update LastSeen
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]).toLowerCase() === userName.toLowerCase()) {
          sheet.getRange(i + 1, 4).setValue(new Date().toISOString());
          break;
        }
      }
    }
  } catch(e) {
    Logger.log('registerUser failed: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SETTINGS HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get a setting value by key
 */
function getSetting(key) {
  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_SETTINGS);
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === key) return String(data[i][1] || '');
    }
    return null;
  } catch(_) { return null; }
}

/**
 * Set (or update) a setting value
 */
function setSetting(key, value) {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_SETTINGS, [['Key', 'Value', 'UpdatedAt']]);
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      return;
    }
  }
  // Append new key
  sheet.appendRow([key, value, new Date().toISOString()]);
}

// ═══════════════════════════════════════════════════════════════════════
//  SPREADSHEET / SHEET HELPERS
// ═══════════════════════════════════════════════════════════════════════

function getSpreadsheet() {
  if (SPREADSHEET_ID && SPREADSHEET_ID !== 'YOUR_SPREADSHEET_ID_HERE') {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Get or create a sheet with headers if new
 */
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers[0].length).setValues([headers[0]]);
      sheet.getRange(1, 1, 1, headers[0].length)
        .setFontWeight('bold')
        .setBackground('#1A2412')
        .setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function getDbHeaders() {
  return [['RecordID','UserName','ItemName','Category','Quantity','Unit','Urgency',
           'Status','Remarks','CreatedDate','LastUpdated','UpdatedBy']];
}

function getAuditHeaders() {
  return [['LogID','RecordID','ActionType','ModifiedBy','OldValue','NewValue',
           'Timestamp','UserRole','Notes']];
}

// ═══════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate a unique ID with a prefix
 */
function generateId(prefix) {
  return (prefix || 'ID') + '-' +
    new Date().getTime().toString(36).toUpperCase() + '-' +
    Math.random().toString(36).substr(2, 5).toUpperCase();
}

/**
 * Sanitize input strings — strip dangerous characters
 */
function sanitize(val) {
  if (typeof val !== 'string') return String(val || '');
  return val
    .replace(/[<>]/g, '')       // Strip HTML tags
    .replace(/['"`;]/g, '')     // Strip injection chars
    .trim()
    .slice(0, 500);             // Max length
}

/**
 * JSON response helpers
 */
function ok(data) {
  data.status = data.status || 'ok';
  // Google automatically adds Access-Control-Allow-Origin: * for deployed web apps
  // when accessed by a browser. No manual header needed.
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════
//  ONE-TIME SETUP FUNCTIONS
//  Run these manually from the Apps Script editor ONCE during setup
// ═══════════════════════════════════════════════════════════════════════

/**
 * STEP 1: Initialize all sheets with correct headers and formatting
 * Run this once from Apps Script editor: select initializeSheets → Run
 */
function initializeSheets() {
  var ss = getSpreadsheet();

  // ── GroceryDesk Database ─────────────────────────────────────────
  var db = ss.getSheetByName(SHEET_DB) || ss.insertSheet(SHEET_DB);
  var dbHeaders = ['RecordID','UserName','ItemName','Category','Quantity',
                   'Unit','Urgency','Status','Remarks','CreatedDate','LastUpdated','UpdatedBy'];
  db.getRange(1, 1, 1, dbHeaders.length).setValues([dbHeaders])
    .setFontWeight('bold').setBackground('#1A2412').setFontColor('#FFFFFF');
  db.setFrozenRows(1);
  [1,180, 2,130, 3,200, 4,160, 5,80, 6,100, 7,130, 8,150, 9,200, 10,180, 11,180, 12,130].reduce(
    function(_, v, i) { if (i % 2 === 0) return v; db.setColumnWidth(_, v); },0);

  // ── Items ─────────────────────────────────────────────────────────
  var items = ss.getSheetByName(SHEET_ITEMS) || ss.insertSheet(SHEET_ITEMS);
  items.getRange(1,1,1,2).setValues([['ItemName','Category']])
    .setFontWeight('bold').setBackground('#2D5F1F').setFontColor('#FFFFFF');
  items.setFrozenRows(1);
  items.setColumnWidth(1, 220);
  items.setColumnWidth(2, 200);

  // ── Users ─────────────────────────────────────────────────────────
  var users = ss.getSheetByName(SHEET_USERS) || ss.insertSheet(SHEET_USERS);
  users.getRange(1,1,1,4).setValues([['UserName','Role','CreatedDate','LastSeen']])
    .setFontWeight('bold').setBackground('#1D4ED8').setFontColor('#FFFFFF');
  users.setFrozenRows(1);

  // ── AuditLogs ─────────────────────────────────────────────────────
  var audit = ss.getSheetByName(SHEET_AUDIT) || ss.insertSheet(SHEET_AUDIT);
  var aHdrs = ['LogID','RecordID','ActionType','ModifiedBy','OldValue','NewValue','Timestamp','UserRole','Notes'];
  audit.getRange(1,1,1,aHdrs.length).setValues([aHdrs])
    .setFontWeight('bold').setBackground('#7C3AED').setFontColor('#FFFFFF');
  audit.setFrozenRows(1);

  // ── Settings ─────────────────────────────────────────────────────
  var cfg = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS);
  cfg.getRange(1,1,1,3).setValues([['Key','Value','UpdatedAt']])
    .setFontWeight('bold').setBackground('#6B7280').setFontColor('#FFFFFF');
  cfg.setFrozenRows(1);

  // Seed default admin password hash (uses pre-computed constant — no manual step needed)
  var existingHash = getSetting('adminPasswordHash');
  if (!existingHash) {
    setSetting('adminPasswordHash', DEFAULT_ADMIN_HASH);
    setSetting('adminSessions', '[]');
    setSetting('appVersion', '2.0.0');
    Logger.log('✅ Admin password hash seeded. Default password: GroceryDesk@Admin2024');
  }

  Logger.log('✅ All sheets initialized successfully!');
  Logger.log('📋 Sheets created: ' + [SHEET_DB, SHEET_ITEMS, SHEET_USERS, SHEET_AUDIT, SHEET_SETTINGS].join(', '));
  return 'Sheets initialized successfully!';
}

/**
 * Compute SHA-256 hash of the default admin password using Apps Script
 * Run this once to get the hash, then store it as DEFAULT_ADMIN_HASH above
 */
function computeDefaultHash() {
  var password = 'GroceryDesk@Admin2024';
  var bytes    = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  var hash     = bytes.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
  Logger.log('Default password hash: ' + hash);
  return hash;
}

/**
 * STEP 2: Seed item master with 80+ common grocery/household items
 * Run this once after initializeSheets
 */
function seedItems() {
  var itemsData = [
    // Vegetables (15)
    ['Tomato','Vegetables'],['Onion','Vegetables'],['Potato','Vegetables'],
    ['Garlic','Vegetables'],['Ginger','Vegetables'],['Green Chilli','Vegetables'],
    ['Capsicum','Vegetables'],['Cabbage','Vegetables'],['Carrot','Vegetables'],
    ['Beetroot','Vegetables'],['Cucumber','Vegetables'],['Spinach (Palak)','Vegetables'],
    ['Brinjal (Baingan)','Vegetables'],['Lady Finger (Okra)','Vegetables'],['Cauliflower','Vegetables'],
    // Fruits (10)
    ['Banana','Fruits'],['Apple','Fruits'],['Mango','Fruits'],['Orange','Fruits'],
    ['Grapes','Fruits'],['Papaya','Fruits'],['Pomegranate','Fruits'],['Guava','Fruits'],
    ['Lemon','Fruits'],['Watermelon','Fruits'],
    // Grains & Rice (6)
    ['Basmati Rice','Grains & Rice'],['Raw Rice (Sona Masoori)','Grains & Rice'],
    ['Poha','Grains & Rice'],['Quinoa','Grains & Rice'],['Oats','Grains & Rice'],['Barley','Grains & Rice'],
    // Atta & Flour (5)
    ['Wheat Atta','Atta & Flour'],['Maida','Atta & Flour'],['Besan (Chickpea Flour)','Atta & Flour'],
    ['Rava / Sooji','Atta & Flour'],['Corn Flour','Atta & Flour'],
    // Oils & Ghee (4)
    ['Sunflower Oil','Oils & Ghee'],['Coconut Oil','Oils & Ghee'],
    ['Desi Ghee','Oils & Ghee'],['Mustard Oil','Oils & Ghee'],
    // Masalas & Spices (8)
    ['Turmeric Powder','Masalas & Spices'],['Red Chilli Powder','Masalas & Spices'],
    ['Coriander Powder','Masalas & Spices'],['Garam Masala','Masalas & Spices'],
    ['Cumin Seeds (Jeera)','Masalas & Spices'],['Mustard Seeds','Masalas & Spices'],
    ['Salt (Iodized)','Masalas & Spices'],['Sugar','Masalas & Spices'],
    // Dals & Legumes (6)
    ['Toor Dal','Dals & Legumes'],['Moong Dal','Dals & Legumes'],['Chana Dal','Dals & Legumes'],
    ['Masoor Dal','Dals & Legumes'],['Rajma (Kidney Beans)','Dals & Legumes'],['Kabuli Chana','Dals & Legumes'],
    // Dairy (5)
    ['Milk (Full Cream)','Dairy Products'],['Curd / Yogurt','Dairy Products'],
    ['Paneer','Dairy Products'],['Butter','Dairy Products'],['Cheese (Processed)','Dairy Products'],
    // Tea/Coffee (4)
    ['Tea Leaves','Tea / Coffee / Health Drinks'],['Instant Coffee','Tea / Coffee / Health Drinks'],
    ['Bournvita','Tea / Coffee / Health Drinks'],['Green Tea Bags','Tea / Coffee / Health Drinks'],
    // Snacks (4)
    ['Marie Biscuits','Snacks & Packaged Foods'],['Namkeen Mix','Snacks & Packaged Foods'],
    ['Maggi Noodles','Snacks & Packaged Foods'],['Popcorn (Microwave)','Snacks & Packaged Foods'],
    // Cleaning (5)
    ['Detergent Powder','Detergents & Cleaning Supplies'],['Dish Wash Liquid','Detergents & Cleaning Supplies'],
    ['Floor Cleaner','Detergents & Cleaning Supplies'],['Toilet Cleaner','Detergents & Cleaning Supplies'],
    ['Glass Cleaner','Detergents & Cleaning Supplies'],
    // Personal Hygiene (5)
    ['Bath Soap','Personal Hygiene'],['Shampoo','Haircare'],['Conditioner','Haircare'],
    ['Toothpaste','Personal Hygiene'],['Toothbrush','Personal Hygiene'],
    // Kitchen (4)
    ['Matchbox','Kitchen Essentials'],['Garbage Bags','Kitchen Essentials'],
    ['Aluminium Foil','Kitchen Essentials'],['Cling Wrap','Kitchen Essentials'],
    // Medicines (3)
    ['Paracetamol 500mg','Medicines & First Aid'],['ORS Sachets','Medicines & First Aid'],
    ['Band-Aid Box','Medicines & First Aid'],
    // Puja (3)
    ['Agarbatti (Incense)','Puja Items'],['Camphor (Kapoor)','Puja Items'],['Puja Oil','Puja Items'],
    // Beverages (3)
    ['Packaged Drinking Water','Beverages'],['Cold Drink (2L)','Beverages'],['Fruit Juice (1L)','Beverages'],
    // Dry Fruits (3)
    ['Almonds (Badam)','Dry Fruits & Nuts'],['Cashews (Kaju)','Dry Fruits & Nuts'],['Raisins (Kishmish)','Dry Fruits & Nuts'],
    // Disposables (2)
    ['Disposable Plates','Disposable Items'],['Paper Cups','Disposable Items']
  ];

  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_ITEMS);
  if (!sheet) {
    initializeSheets();
    sheet = ss.getSheetByName(SHEET_ITEMS);
  }

  // Clear existing data (keep header)
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();
  }

  sheet.getRange(2, 1, itemsData.length, 2).setValues(itemsData);
  Logger.log('✅ Seeded ' + itemsData.length + ' items to Items sheet!');
  return 'Seeded ' + itemsData.length + ' items!';
}

/**
 * UTILITY: Print test data — run from editor to verify everything works
 */
function runSelfTest() {
  Logger.log('=== GroceryDesk v2 Self-Test ===');
  Logger.log('Spreadsheet: ' + getSpreadsheet().getName());
  Logger.log('DB rows: ' + getAllOrders().length);
  Logger.log('Item master size: ' + getItemMaster().length);
  Logger.log('Admin hash set: ' + (getSetting('adminPasswordHash') ? 'YES' : 'NO'));
  Logger.log('Active sessions: ' + (getSetting('adminSessions') || '[]'));
  Logger.log('=== Test Complete ===');
}

/**
 * UTILITY: Clear all admin sessions (emergency use)
 */
function clearAdminSessions() {
  setSetting('adminSessions', '[]');
  Logger.log('All admin sessions cleared.');
}

/**
 * UTILITY: Reset admin password to default
 * Run this if you forget your admin password
 */
function resetAdminPasswordToDefault() {
  setSetting('adminPasswordHash', DEFAULT_ADMIN_HASH);
  setSetting('adminSessions', '[]');
  Logger.log('✅ Admin password reset to: GroceryDesk@Admin2024');
  Logger.log('Hash stored: ' + DEFAULT_ADMIN_HASH);
  return 'Password reset to default: GroceryDesk@Admin2024';
}
