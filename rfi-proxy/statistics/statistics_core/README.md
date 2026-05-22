# statistics_core

Pure helper code for the BelloTreno statistics service.

The production entrypoint is still `app.py`; this package exists so high-risk helper logic can be tested before larger backend decomposition. Move code here only when it has no Flask, SQLite, thread, or network dependency.

Good candidates:

- service-date parsing and filtering
- category normalization
- train-key construction
- small row normalizers

Do not move collector scheduling, database writes, or API route handlers here until they are split into dedicated runtime modules.
