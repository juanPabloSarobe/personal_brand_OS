-- Catálogo de canales (máster plan, spec §10)
INSERT INTO channels (code, name, status, publisher_module) VALUES
  ('linkedin',         'LinkedIn',          'activo',      'linkedin'),
  ('instagram',        'Instagram',         'activo',      'instagram'),
  ('wa_status',        'WhatsApp Status',   'activo',      'manual'),
  ('telegram_channel', 'Canal de Telegram', 'planificado', NULL),
  ('x',                'X (Twitter)',       'planificado', NULL),
  ('threads',          'Threads',           'planificado', NULL),
  ('bluesky',          'Bluesky',           'planificado', NULL),
  ('tiktok',           'TikTok',            'planificado', NULL),
  ('youtube',          'YouTube',           'planificado', NULL),
  ('sitio_propio',     'Sitio propio',      'planificado', NULL);

-- Formatos por canal (spec §6). automatable: 1 = publica la API, 0 = paquete manual
INSERT INTO channel_formats (channel_id, code, name, automatable, specs_json) VALUES
  ((SELECT id FROM channels WHERE code='linkedin'), 'texto',     'Post de texto',        1, '{"max_chars":3000}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'imagen',    'Post con imagen',      1, '{"max_chars":3000,"max_imgs":9}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'video',     'Post con video',       1, '{"max_chars":3000}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'documento', 'Documento (carrusel)', 1, '{"formato":"pdf"}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'feed',     'Foto en feed',         1, '{"aspect":"1:1|4:5","max_chars":2200}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'carrusel', 'Carrusel',             1, '{"max_items":10,"max_chars":2200}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'historia', 'Historia',             1, '{"aspect":"9:16"}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'reel',     'Reel',                 0, '{"aspect":"9:16","max_seg":90,"nota":"v2: pipeline de video"}'),
  ((SELECT id FROM channels WHERE code='wa_status'), 'historia', 'Estado',               0, '{"aspect":"9:16","entrega":"paquete_manual"}');
