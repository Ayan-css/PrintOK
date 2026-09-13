/**
 * Landing page motion.
 *
 * Deliberately separate from landing.js, which carries the page's data and
 * forms. Nothing here is required for the page to be understood: the markup
 * and stylesheet already present every section in its finished state, and this
 * file only adds the travelling between those states.
 *
 * Three rules it keeps to:
 *
 *   1. If GSAP fails to load, or the visitor has asked for reduced motion, the
 *      page stays exactly as the stylesheet left it. Nothing is hidden by a
 *      script that might not run — the usual way scroll animation breaks a page.
 *   2. Only transform and opacity are animated, so the compositor does the work
 *      and no frame costs a layout.
 *   3. ScrollTriggers are created once and use class toggles rather than
 *      per-frame tweens, so scrolling stays cheap on a mid-range phone.
 */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function init() {
    // No GSAP (blocked, offline, CDN down) means no motion, not a broken page.
    if (reduced || typeof window.gsap === 'undefined') return;

    var gsap = window.gsap;
    var ScrollTrigger = window.ScrollTrigger;
    if (ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

    heroEntrance(gsap);
    if (ScrollTrigger) {
      fileJourney(gsap);
      revealSections(gsap);
    }
  }

  /**
   * The hero settles in rather than appearing. Runs once, immediately, and
   * never on scroll — the first thing a visitor sees should not wait for them
   * to do anything.
   */
  function heroEntrance(gsap) {
    var copy = document.querySelector('.landing-hero-copy');
    var visual = document.querySelector('.landing-hero-visual');
    if (!copy) return;

    var bits = copy.querySelectorAll('.eyebrow, h1, .lede, .landing-cta-row, .hero-stats');
    var tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.7 } });

    tl.from(bits, { y: 18, opacity: 0, stagger: 0.08 });

    if (visual) {
      tl.from(visual, { y: 28, opacity: 0, duration: 0.9 }, 0.15);

      // The steps light up in order, so the card reads as a queue moving
      // rather than a static list that happens to be coloured.
      var steps = visual.querySelectorAll('.flow-step');
      if (steps.length) {
        tl.from(steps, { x: -12, opacity: 0, stagger: 0.09, duration: 0.5 }, 0.45);
      }
    }
  }

  /**
   * The sheet of paper travels from the phone, through the cloud, into the
   * printer, as the three explanations scroll past the sticky illustration.
   *
   * The class is added here rather than in the markup so the dimming and the
   * paper's starting position only apply once something is actually driving
   * them. Without this, a visitor with no JS would see two faded stations and
   * a sheet stuck inside a phone.
   */
  function fileJourney(gsap) {
    var section = document.querySelector('.journey');
    if (!section) return;

    var steps = section.querySelectorAll('.journey-step');
    var stations = section.querySelectorAll('.jr-station');
    var paper = section.querySelector('[data-paper]');
    if (!steps.length || !stations.length || !paper) return;

    section.classList.add('js-journey');

    // Where the sheet rests at each stage, in the SVG's own coordinates.
    var STOPS = [
      { x: 180, y: 79, rotation: 0, scale: 1 },     // on the phone screen
      { x: 180, y: 278, rotation: -6, scale: 0.86 }, // in the cloud
      { x: 180, y: 470, rotation: 0, scale: 1 },     // in the printer tray
    ];

    gsap.set(paper, STOPS[0]);

    function activate(index) {
      for (var i = 0; i < stations.length; i++) {
        stations[i].classList.toggle('is-active', i === index);
      }
      for (var j = 0; j < steps.length; j++) {
        steps[j].classList.toggle('is-active', j === index);
      }

      gsap.to(paper, {
        x: STOPS[index].x,
        y: STOPS[index].y,
        rotation: STOPS[index].rotation,
        scale: STOPS[index].scale,
        duration: 0.75,
        ease: 'power2.inOut',
        overwrite: true,
      });
    }

    steps.forEach(function (step, index) {
      ScrollTrigger.create({
        trigger: step,
        // A step owns the illustration while it occupies the middle band of
        // the screen, which is where the eye is while reading it.
        start: 'top 65%',
        end: 'bottom 45%',
        onEnter: function () { activate(index); },
        onEnterBack: function () { activate(index); },
      });
    });

    activate(0);
  }

  /**
   * Cards rise slightly as they arrive. `once` matters: re-animating on the way
   * back up makes a page feel restless, and costs frames for nothing.
   *
   * Headings and body copy are deliberately not included. A `from` tween sets
   * its start state the moment it is created, so anything listed here sits at
   * opacity 0 until it is scrolled to — and if a later script error stopped
   * ScrollTrigger refreshing, it would stay there. Losing a card's entrance is
   * a missing flourish; losing a section heading is a missing page.
   */
  function revealSections(gsap) {
    var targets = document.querySelectorAll(
      '.walk-step, .price-card, .benefit, .faq-item, .journey-step'
    );
    if (!targets.length) return;

    targets.forEach(function (el) {
      gsap.from(el, {
        y: 22,
        opacity: 0,
        duration: 0.6,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
