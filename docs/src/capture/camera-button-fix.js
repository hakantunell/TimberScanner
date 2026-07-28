const oldButton = document.querySelector('#start-camera');

if (oldButton) {
  const cleanButton = oldButton.cloneNode(true);
  cleanButton.disabled = false;
  cleanButton.removeAttribute('onclick');

  cleanButton.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const status = document.querySelector('#camera-status');
    if (status) status.textContent = 'Ren kameraknapp mottagen · startar endast en kamerastream…';

    try {
      if (!window.TimberCamera?.start) {
        throw new Error('TimberCamera är inte laddad');
      }
      await window.TimberCamera.start();
    } catch (error) {
      if (status) status.textContent = `Kamerastart misslyckades: ${error.message}`;
      console.error('[camera-button-fix]', error);
    }
  });

  oldButton.replaceWith(cleanButton);
  const status = document.querySelector('#camera-status');
  if (status) status.textContent = 'Kameramodul v20260728-5 redo · gammal dubbelstart bortkopplad';
}
