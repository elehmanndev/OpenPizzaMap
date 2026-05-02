# 2026-05-02 — lamejorpizza.es scrape: skipped venues

Scraped 141 venues from lamejorpizza.es. Quality gate (any of: award-tier, ≥4.3★ × ≥100 reviews on Google, already in DB) passed by 96; 45 did not.

Already-in-DB rows are skipped silently (the importer dedupe handles them). Rating-gate failures and "no Google data" rows are listed below for review.

## Skip reason summary

- **15** — already-in-db
- **6** — 4.1
- **5** — 4.2
- **3** — 4
- **3** — gate fail
- **2** — 3.5
- **1** — no Google data
- **1** — 13 reviews < 100
- **1** — 3.6
- **1** — 3.8
- **1** — 89 reviews < 100
- **1** — 52 reviews < 100
- **1** — 81 reviews < 100
- **1** — 93 reviews < 100
- **1** — 44 reviews < 100
- **1** — 3.9
- **1** — 23 reviews < 100

## Rating-gate failures

| LMP id | name | city | rating | reviews | reason |
|---:|---|---|---:|---:|---|
| 405 | Toxo Pizzería | Las Torres de cotillas | 4.9 | 81 | 81 reviews < 100 |
| 312 | Trozzo Alba de Tormes | alba de Tormes | 4.8 | 13 | 13 reviews < 100 |
| 313 | Trozzo Plasencia | Plasencia | 4.8 | 23 | 23 reviews < 100 |
| 374 | Gula | Villacañas | 4.6 | 89 | 89 reviews < 100 |
| 431 | Garden Gastrobar | Pola de Laviana | 4.3 | 44 | 44 reviews < 100 |
| 342 | Dulmi | SEVILLA | 4.2 | 1109 | 4.2★ < 4.3 |
| 355 | Sinuessa Betanzos | Betanzos | 4.2 | 1240 | 4.2★ < 4.3 |
| 414 | Il Coltello Albacete | Albacete | 4.2 | 414 | 4.2★ < 4.3 |
| 345 | Pizzeria Ezaro | vitoria | 4.2 | 102 | 4.2★ < 4.3 |
| 325 | EsPanis | Las Rozas de Madrid | 4.2 | 2165 | 4.2★ < 4.3 |
| 327 | Pizzeria Pulcinella | Pamplona | 4.1 | 313 | 4.1★ < 4.3 |
| 437 | Restaurante Di Manuella Cocina Italiana |  | 4.1 | 504 | 4.1★ < 4.3 |
| 322 | Fiera Bar | Gijón | 4.1 | 463 | 4.1★ < 4.3 |
| 343 | La tua pizza | Xeraco | 4.1 | 228 | 4.1★ < 4.3 |
| 421 | LA FUSIÓN | Aguadulce | 4.1 | 899 | 4.1★ < 4.3 |
| 347 | Pizzeria la Vall Express | Tavernes de la Valldigna | 4.1 | 154 | 4.1★ < 4.3 |
| 379 | Barrios pizza | Las palmas | 4 | 302 | 4★ < 4.3 |
| 446 | Tutti Ricchi | Pamplona | 4 | 63 | 4★ < 4.3 |
| 310 | El Italiano | Santander | 4 | 2282 | 4★ < 4.3 |
| 413 | La Rima Fast-Food Gourmet | Burgos | 3.9 | 1224 | 3.9★ < 4.3 |
| 352 | Azzurro restaurante pizzería | Barcelona | 3.8 | 1767 | 3.8★ < 4.3 |
| 382 | Dottor pizza | Vitoria - Gasteiz | 3.6 | 1815 | 3.6★ < 4.3 |
| 399 | Pizzería Mayor La Solana | La Solana | 3.5 | 246 | 3.5★ < 4.3 |
| 349 | Gusto | Malaga | 3.5 | 69 | 3.5★ < 4.3 |
| 368 | Pizzeria Mayor Piedrabuena | Piedrabuena |  | 52 | 52 reviews < 100 |
| 311 | Trozzo Guijuelo | Guijuelo |  | 93 | 93 reviews < 100 |

## No Google data found

| LMP id | name | city |
|---:|---|---|
| 420 | Pizzeria Gnomo | Almuñecar |

## Already in DB (silent skips)

| LMP id | LMP name | city | matched DB row |
|---:|---|---|---|
| 340 | Rústica Napoletana | Cazalla de la Sierra | id=1790 Rústica Napoletana |
| 426 | FIVE NAPOLI PIZZA SALAMANCA | SALAMANCA | id=972 Five Napoli Pizza |
| 316 | Baldoria | Madrid | id=1472 Baldoria |
| 344 | PIZZERIA PRIMAVERA MALAGA | MALAGA | id=1820 Pizzeria Primavera |
| 346 | Curuxera Langreo | Langreo | id=890 Curuxera |
| 387 | Infraganti Pizza Bar San Juan | Alicante | id=1496 Infraganti |
| 388 | Infraganti Pizza Bar Murcia | Murcia | id=1496 Infraganti |
| 303 | Pizzeria Rifugio | Madrid | id=1788 Pizzeria Rifugio |
| 423 | Alimentari e Diversi | Sevilla | id=1774 Alimentari |
| 323 | Pizzería Primavera FUENGIROLA | Fuengirola | id=1820 Pizzeria Primavera |
| 390 | Infraganti Pizza Bar Elche | Elche | id=1496 Infraganti |
| 359 | Trafalgar Pizza Club | Barcelona | id=1792 TRAFALGAR |
| 384 | Infraganti Pizza Bar Alicante | alicante | id=1496 Infraganti |
| 427 | FIVE NAPOLI PIZZA VALLADOLID | VALLADOLID | id=972 Five Napoli Pizza |
| 392 | Infraganti Pizza Bar Muchavista | El Campello | id=1496 Infraganti |
