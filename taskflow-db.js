// ══════════════════════════════════════════════════════════════
// TASKFLOW — IndexedDB PERSISTENCE LAYER
// Shared by panel.html and functions.html
// ══════════════════════════════════════════════════════════════

const TaskFlowDB = (() => {
  const DB_NAME    = 'TaskFlowDB';
  const DB_VERSION = 1;
  const TASKS_STORE    = 'tasks';
  const PROJECTS_STORE = 'projects';

  // Legacy localStorage keys (for migration)
  const LS_TASKS    = 'taskflow_tasks';
  const LS_PROJECTS = 'taskflow_projects';

  let _db = null;

  // ── OPEN / INIT ─────────────────────────────────────────────
  function open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Tasks store — keyPath = id
        if (!db.objectStoreNames.contains(TASKS_STORE)) {
          const store = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
          store.createIndex('emailId', 'emailId', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('created', 'created', { unique: false });
        }

        // Projects store — keyPath = id
        if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
          db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        _db = e.target.result;
        resolve(_db);
      };

      req.onerror = (e) => {
        console.error('TaskFlowDB: open failed', e.target.error);
        reject(e.target.error);
      };
    });
  }

  // ── GENERIC HELPERS ─────────────────────────────────────────
  function _tx(storeName, mode) {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror   = () => reject(request.error);
    });
  }

  // ── TASKS CRUD ──────────────────────────────────────────────

  /** Get all tasks, sorted by created DESC */
  function getAllTasks() {
    return _promisify(_tx(TASKS_STORE, 'readonly').getAll())
      .then(tasks => tasks.sort((a, b) => (b.created || 0) - (a.created || 0)));
  }

  /** Get a single task by id */
  function getTask(id) {
    return _promisify(_tx(TASKS_STORE, 'readonly').get(id));
  }

  /** Normalitza un emailId per comparació robusta (EWS vs REST, majúscules...) */
  function normalizeEmailId(id) {
    if (!id) return '';
    return String(id).trim().toLowerCase();
  }

  /** Find tasks by emailId — cerca per ID original i normalitzat */
  function getTasksByEmail(emailId) {
    if (!emailId) return Promise.resolve([]);
    const normalizedSearch = normalizeEmailId(emailId);
    // Busquem primer per l'ID tal com arriba, després per l'ID normalitzat
    // i finalment fem un getAll i filtrem (per cobrir casos de format diferent)
    return getAllTasks().then(allTasks =>
      allTasks.filter(t => {
        const stored = t.emailId || '';
        return stored === emailId ||
               normalizeEmailId(stored) === normalizedSearch;
      })
    );
  }

  /** Find tasks by conversationId — cerca robusta */
  function getTasksByConversation(convId) {
    if (!convId) return Promise.resolve([]);
    const normalizedSearch = normalizeEmailId(convId);
    return getAllTasks().then(allTasks =>
      allTasks.filter(t => {
        const stored = t.conversationId || '';
        return stored === convId ||
               normalizeEmailId(stored) === normalizedSearch;
      })
    );
  }

  /** Add or update a task (put = upsert) */
  function putTask(task) {
    return _promisify(_tx(TASKS_STORE, 'readwrite').put(task));
  }

  /** Add multiple tasks at once */
  function putTasks(tasksArr) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);
      tasksArr.forEach(t => store.put(t));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  /** Delete a task by id */
  function deleteTask(id) {
    return _promisify(_tx(TASKS_STORE, 'readwrite').delete(id));
  }

  /** Check if a task with this emailId already exists */
  function taskExistsForEmail(emailId) {
    return getTasksByEmail(emailId).then(arr => arr.length > 0);
  }

  // ── PROJECTS CRUD ───────────────────────────────────────────

  function getAllProjects() {
    return _promisify(_tx(PROJECTS_STORE, 'readonly').getAll());
  }

  function putProject(project) {
    return _promisify(_tx(PROJECTS_STORE, 'readwrite').put(project));
  }

  // ── MIGRATION FROM localStorage ─────────────────────────────
  // Runs once: imports existing data then clears localStorage keys

  function migrateFromLocalStorage() {
    return getAllTasks().then(existing => {
      // Only migrate if IndexedDB is empty
      if (existing.length > 0) return Promise.resolve(false);

      const lsTasks = JSON.parse(localStorage.getItem(LS_TASKS) || '[]');
      const lsProjects = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');

      if (lsTasks.length === 0 && lsProjects.length === 0) {
        return Promise.resolve(false);
      }

      // Import tasks
      const taskPromise = lsTasks.length > 0
        ? putTasks(lsTasks)
        : Promise.resolve();

      // Import projects
      const projPromise = lsProjects.length > 0
        ? new Promise((resolve, reject) => {
            const tx = _db.transaction(PROJECTS_STORE, 'readwrite');
            const store = tx.objectStore(PROJECTS_STORE);
            lsProjects.forEach(p => store.put(p));
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
          })
        : Promise.resolve();

      return Promise.all([taskPromise, projPromise]).then(() => {
        // Clear legacy storage after successful migration
        localStorage.removeItem(LS_TASKS);
        localStorage.removeItem(LS_PROJECTS);
        console.log('TaskFlowDB: migrated', lsTasks.length, 'tasks and', lsProjects.length, 'projects from localStorage');
        return true;
      });
    });
  }

  // ── INIT: open + migrate ────────────────────────────────────
  function init() {
    return open().then(() => migrateFromLocalStorage());
  }

  // ── PUBLIC API ──────────────────────────────────────────────
  return {
    init,
    open,
    getAllTasks,
    getTask,
    getTasksByEmail,
    getTasksByConversation,
    putTask,
    putTasks,
    deleteTask,
    taskExistsForEmail,
    getAllProjects,
    putProject,
    migrateFromLocalStorage
  };
})();
