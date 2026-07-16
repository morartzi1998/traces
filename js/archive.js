/*
  traces — the user's own archive (persisted in the browser)

  Two archives live in the interface:
   - "my archive"   — the designer's own home scans, a fixed showcase reached
                      from the About screen (screens/archive-mine.html)
   - "your archive" — the visitor's own captures. Starts empty and fills as they
                      scan/upload. Persisted here in localStorage so it survives
                      reloads. This is what the top-nav "Archive" link opens.

  A capture looks like:
    { id, title, img, model, feeling, kind, created, annotations: [] }
  where `img` is a thumbnail (data URL or path) and `model` is an optional GLB
  URL (added once real 3D reconstruction runs).
*/

(function () {
  function store(KEY) {
    function load() {
      try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
    }
    function save(list) {
      try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    }
    return {
      all: function () { return load(); },
      get: function (id) {
        var found = load().filter(function (c) { return c.id === id; });
        return found[0] || null;
      },
      add: function (cap) {
        var list = load();
        cap.id = cap.id || ("cap-" + Date.now());
        cap.created = cap.created || Date.now();
        if (!Array.isArray(cap.annotations)) cap.annotations = [];
        list.unshift(cap);
        save(list);
        return cap;
      },
      remove: function (id) {
        save(load().filter(function (c) { return c.id !== id; }));
      },
      update: function (id, patch) {
        var list = load();
        var found = null;
        list.forEach(function (c) {
          if (c.id === id) { Object.assign(c, patch); found = c; }
        });
        if (found) save(list);
        return found;
      },
      clear: function () { save([]); }
    };
  }

  // "your archive" (private) and the shared community feed — two persisted lists
  window.Archive = store("traces-user-captures");
  window.Community = store("traces-community-captures");
})();
