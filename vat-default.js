document.addEventListener('click', event => {
  if (!event.target.closest('[data-action="new-sale"]')) return;
  queueMicrotask(() => {
    const vat = document.querySelector('#modal-content input[name="vatEnabled"]');
    if (vat) {
      vat.checked = false;
      vat.defaultChecked = false;
    }
  });
}, true);
