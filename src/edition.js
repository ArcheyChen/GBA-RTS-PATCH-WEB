(function () {
  document.documentElement.dataset.rtsEdition = 'public';
  document.addEventListener('DOMContentLoaded', function () {
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
      const offlineCard = document.getElementById('publicOfflineCard');
      if (offlineCard) offlineCard.hidden = true;
    }
  });
})();
