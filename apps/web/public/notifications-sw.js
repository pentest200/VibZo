/* global self */
// Never cache private API data or trust push-supplied text, identities or click URLs.
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('Commonroom', {
    body: 'Open Commonroom to check your conversations.', tag: 'commonroom-inbox'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/chat'));
});
