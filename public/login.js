const form = document.getElementById('loginForm');
const email = document.getElementById('email');
const password = document.getElementById('password');
const errorBox = document.getElementById('loginError');
const button = document.getElementById('loginButton');
const toggle = document.getElementById('togglePassword');

toggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  toggle.textContent = visible ? 'Anzeigen' : 'Ausblenden';
  toggle.setAttribute('aria-label', visible ? 'Passwort anzeigen' : 'Passwort ausblenden');
  password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = 'Anmeldung läuft …';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen.');
    window.location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    password.select();
  } finally {
    button.disabled = false;
    button.textContent = 'Anmelden';
  }
});
