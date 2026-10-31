/*
 * Interactivity for the showcase. Plain script, no library, no network. It only reads attributes the build wrote
 * into the page, and it writes text with textContent, never HTML. Without this script, the list under each
 * diagram carries the same information.
 */
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  function show(diagram, node) {
    var id = node.getAttribute('data-node');
    diagram.querySelectorAll('[data-node]').forEach(function (other) {
      var selected = other.getAttribute('data-node') === id;
      other.classList.toggle('is-selected', selected);
      other.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    var panel = diagram.querySelector('[data-detail]');
    if (!panel) return;
    panel.querySelector('[data-detail-title]').textContent = node.getAttribute('data-title') || '';
    panel.querySelector('[data-detail-summary]').textContent =
      node.getAttribute('data-summary') || '';
    var source = panel.querySelector('[data-detail-source]');
    source.setAttribute('href', node.getAttribute('data-href') || '#');
    source.textContent = node.getAttribute('data-path') || '';
    var proof = panel.querySelector('[data-detail-proof]');
    proof.setAttribute('href', node.getAttribute('data-proof-href') || '#');
    proof.textContent = node.getAttribute('data-proof') || '';
  }

  document.querySelectorAll('[data-diagram]').forEach(function (diagram) {
    diagram.addEventListener('click', function (event) {
      var node = event.target.closest && event.target.closest('[data-node]');
      if (node && diagram.contains(node)) show(diagram, node);
    });
    diagram.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var node = event.target.closest && event.target.closest('[data-node]');
      if (!node || !diagram.contains(node)) return;
      event.preventDefault();
      show(diagram, node);
    });
    var first = diagram.querySelector('[data-node]');
    if (first) show(diagram, first);
  });
})();
