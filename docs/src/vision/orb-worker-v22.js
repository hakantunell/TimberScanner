// Ny fysisk workerfil för att kringgå aggressiv browser/CDN-cache.
// Den egentliga ORB-implementationen laddas från samma origin med explicit version.
importScripts('./orb-worker.js?v=20260728-21');
