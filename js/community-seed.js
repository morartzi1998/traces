/*
  traces — the community's shared showcase

  Real scans someone else made and chose to share, seeded from
  community/manifest.json so the Community feed isn't empty before real
  visitors start sharing their own captures. Adding a new one is just:
  drop the model/thumbnail under community/, add one entry to the
  manifest, push — no code changes needed on either page that reads it.

  window.communitySeedReady resolves with the manifest array once fetched;
  window.COMMUNITY_SEED is set at the same time for callers that only run
  after that promise settles (community.html renders after awaiting it;
  object.html merges entries into its own catalog before opening a capture).
*/
window.communitySeedReady = fetch("../community/manifest.json")
  .then(function (r) { return r.ok ? r.json() : []; })
  .catch(function () { return []; })
  .then(function (list) {
    window.COMMUNITY_SEED = list;
    return list;
  });
