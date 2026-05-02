# Visibility-flip dup review — 2026-05-02

After the 50TP Europe 2025 + Excellent import, 197 newly-created hidden rows from non-ES/PT countries were candidates for bulk visibility flip.

Heuristic: skip if name (case-insensitive, trimmed) matches an existing visible row in the same country, OR coords are within 150 m of an existing visible row.

Result: 67 flipped visible, 130 skipped as suspected duplicates.

Below is the skip list — review when you have a moment to decide which (if any) are real new venues vs. the heuristic catching a true duplicate. To flip a specific id manually:

    UPDATE Place SET isVisible = true WHERE id = <id>;

## Skipped duplicates (130)

| new id | country | city | new name | reason |
|---:|---|---|---|---|
| 1603 | United Kingdom | London | 50 Kalò (Londra) | 17 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1604 | United States | New York | Totonno's Pizzeria Napolitana | same name |
| 1605 | United States | New York | Patsy's Pizzeria | same name |
| 1606 | United States | New York | Rubirosa Pizza | same name |
| 1607 | United States | New York | Joe's Pizza | same name |
| 1608 | United States | New York | Di Fara Pizza | same name |
| 1609 | United States | New York | Juliana's | same name |
| 1610 | United States | New York | John's of Bleecker Street | same name |
| 1611 | United States | New York | Joe & Pat's Pizzeria | same name |
| 1612 | United States | New York | Louie & Ernie's Pizza | same name |
| 1613 | United States | New York | Lombardi's Pizza | 133 m from id=187 'Rubirosa Pizza' |
| 1614 | United States | New York | Grimaldi's | 86 m from id=190 'Juliana's' |
| 1615 | United States | New York | Lucali | same name |
| 1616 | United States | New York | Sal & Carmine Pizza | same name |
| 1617 | United States | New York | L'Industrie Pizzeria | same name |
| 1618 | Italy | Naples | Di Matteo | 6 m from id=177 'Antica Pizzeria e Friggitoria Di Matteo' |
| 1619 | Italy | Naples | Trianon da Ciro | 51 m from id=175 'L'Antica Pizzeria da Michele' |
| 1621 | United States | Denver | Marco’s Coal Fired | same name |
| 1623 | Italy | Naples | La Figlia Del Presidente | 92 m from id=144 'La Figlia del Presidente (Napoli)' |
| 1625 | Austria | Vienna | Riva Türkenstraße | same name |
| 1626 | Italy | Bra | 480° Gradi | same name |
| 1627 | Italy | Lecce | 400° Gradi | same name |
| 1628 | Italy | Verona | Peperino Pizza & Grill Verona | 3 m from id=72 'Peperino (Verona)' |
| 1629 | Russia | Omsk | Pizzot° | same name |
| 1630 | Sweden | Skellefteå | Alhems Trädgård | same name |
| 1631 | Sweden | Alingsås | Da Riccardo | same name |
| 1632 | Germany | Osnabrück | Nola- Neapolitanische Pizza+Weinbar | same name |
| 1633 | France | Bourg en Bresse | Pulcinella 01 | 0 m from id=738 'Pulcinella' |
| 1634 | Sweden | Ängelholm | JaJa Napoli | same name |
| 1635 | Brazil | Armação dos Búzios | Maria Italiana | same name |
| 1636 | Italy | Florence | Giotto | 0 m from id=47 'Giotto Pizzeria Bistrot' |
| 1637 | France | Nîmes | La locanda Comptoir Italien | same name |
| 1638 | Japan | Sanda | Pizzeria “En” | same name |
| 1639 | Poland | ŁÓDŹ | Pizza Otto | same name |
| 1640 | Germany | München-Hallbergmoos | Oro di Napoli | same name |
| 1641 | India | Surat | Si Nonna's – IWC VIP ROAD | same name |
| 1642 | India | New Delhi | Si Nonna's – DLF AVENUE SAKET | same name |
| 1643 | India | Gurugram | Si Nonna's – URBAN CUBES | same name |
| 1644 | India | Bengaluru | Si Nonna's – KAMMANHALLI | same name |
| 1645 | India | Bengaluru | Si Nonna's – Bhartiya City | same name |
| 1646 | United States | IL 60614 | Pat's Pizzeria & Ristorante | 5 m from id=1019 'Pat's Pizza' |
| 1647 | United States | IL 60647 | Bungalow by Middle Brow | same name |
| 1648 | United States | IL 60652 | Vito & Nick's | same name |
| 1649 | United States | IL 60613 | Bartoli's | 7 m from id=218 'Bartoli's Pizzeria' |
| 1650 | United States | IL 60657 | The Art of Pizza | same name |
| 1651 | United States | IL 60614 | Pequod's | 4 m from id=216 'Pequod's Pizza' |
| 1652 | United States | Chicago | Milly's Pizza In The Pan | same name |
| 1653 | United States | IL 60611 | Gino's East | same name |
| 1654 | United States | IL 60616 | Williams Inn Pizza & Sports Bar | same name |
| 1655 | United States | Chicago | Paulie Gee’s Logan Square | 6 m from id=1018 'Paulie Gee's' |
| 1656 | United States | MI 48021 | Cloverleaf Bar & Restaurant | same name |
| 1657 | United States | TX 75201 | Partenope Ristorante | same name |
| 1658 | United Kingdom | London NW1 6UY | L'Antica Pizzeria da Michele | 6 m from id=1214 'L’Antica Pizzeria Da Michele London (Baker Street)' |
| 1659 | United Kingdom | London WC2N 5BY | 50 Kalò di Ciro Salvo Pizzeria London | 0 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1661 | Italy | San Bonifacio (VR) | I Tigli | same name |
| 1663 | Italy | Caiazzo (CE) | Pepe in Grani | 106 m from id=291 'Antica Osteria Pizzeria Pepe' |
| 1665 | Italy | Sarzana (SP) | Officine del Cibo | same name |
| 1668 | Italy | Querceta (LU) | Battil’oro | same name |
| 1669 | Italy | Pesche (IS) | Bas | 0 m from id=1457 'Bas & Co' |
| 1671 | Italy | San Giuseppe Vesuviano (NA) | Luigi Cippitelli Pizzeria | 0 m from id=1455 'Pizzeria Luigi Cippitelli' |
| 1672 | Italy | Baveno (VB) | Fiore di Latte | 0 m from id=1466 'Pizzeria Fiore di Latte' |
| 1674 | Italy | Aversa (CE) | Carlo Sammarco Pizzeria 2.0 | 0 m from id=1395 'Carlo Sammarco Pizzeria' |
| 1675 | Italy | Ercolano (NA) | Pizzeria Le Parùle | 0 m from id=1396 'Le Parùle' |
| 1676 | Italy | Arielli (CH) | Giangi Pizza e Ricerca | 0 m from id=1402 'Giangi' |
| 1677 | Italy | Pontecagnano Faiano (SA) | I Borboni Pizzeria | 0 m from id=1405 'I Borboni' |
| 1678 | Italy | Colle di Val d'Elsa (SI) | Pizzeria Chicco | 0 m from id=1417 'Chicco' |
| 1679 | Italy | Este (PD) | Pizzeria Gigi Pipa | 0 m from id=1409 'Gigi Pipa' |
| 1680 | Italy | Altavilla Milicia (PA) | Saccharum Pizzeria Ristorante | 0 m from id=1404 'Saccharum' |
| 1681 | Italy | Corciano (PG) | Meunier Champagne & Pizza | 0 m from id=1403 'Meunier' |
| 1682 | Italy | Pomigliano d'Arco (NA) | Pizzeria I Vesuviani | 0 m from id=1393 'I Vesuviani' |
| 1686 | Italy | Pistoia | La Fenice Pizzeria Contemporanea | 0 m from id=1398 'La Fenice' |
| 1687 | Italy | Marano Vicentino (VI) | CUORE di Luca Brancati | 0 m from id=1435 'CUORE – Luca Brancati' |
| 1688 | Italy | Guardiagrele (CH) | La Sorgente Pizzeria | 0 m from id=1422 'La Sorgente' |
| 1689 | Italy | Volla (NA) | PiGreco Pizzeria | 0 m from id=1429 'PiGreco' |
| 1690 | Austria | Vienna | Via Toledo | 0 m from id=1266 'Pizzeria Riva - Summerstage' |
| 1691 | United Kingdom | London | 50 Kalò | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1693 | France | Paris | Oobatz | 0 m from id=1487 'La Manifattura' |
| 1696 | France | Paris | Roco | 0 m from id=1487 'La Manifattura' |
| 1699 | France | Paris | Fimmina | 0 m from id=1487 'La Manifattura' |
| 1705 | Austria | Vienna | Piazza Colombo | 0 m from id=1266 'Pizzeria Riva - Summerstage' |
| 1706 | Austria | Vienna | Sette | 0 m from id=1266 'Pizzeria Riva - Summerstage' |
| 1713 | Croatia | Zagreb | Basta | 0 m from id=1481 'Franko’s Pizza & Bar' |
| 1718 | United Kingdom | London | A’Do’RE’ fritto | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1720 | United Kingdom | London | Bravi Ragazzi | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1721 | United Kingdom | London | DoppioZero | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1724 | United Kingdom | London | Oi Vita Pizzeria | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1725 | United Kingdom | London | Papi’s Munchies Pizza | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1726 | United Kingdom | London | Vicoli di Napoli | 94 m from id=592 '50 Kalò di Ciro Salvo London' |
| 1727 | Estonia | Tallinn | La Pizzeria di Orm Oja | 0 m from id=1495 'Margherita Pizzeria' |
| 1728 | France | Paris | Anima | 0 m from id=1487 'La Manifattura' |
| 1729 | France | Paris | Bobby | 0 m from id=1487 'La Manifattura' |
| 1730 | France | Paris | Da Valentina | 0 m from id=1487 'La Manifattura' |
| 1731 | France | Paris | Daroco | 0 m from id=1487 'La Manifattura' |
| 1732 | France | Paris | Faggio | 0 m from id=1487 'La Manifattura' |
| 1733 | France | Paris | Fratelli Castellano | 0 m from id=1487 'La Manifattura' |
| 1736 | France | Paris | La Vittoria | 0 m from id=1487 'La Manifattura' |
| 1737 | France | Paris | Louie Louie | 0 m from id=1487 'La Manifattura' |
| 1739 | France | Paris | Prima | 0 m from id=1487 'La Manifattura' |
| 1741 | Germany | Berlin | Gazzo | 0 m from id=1492 'Futura Neapolitan Pizza' |
| 1742 | Germany | Berlin | Gemello | 0 m from id=1492 'Futura Neapolitan Pizza' |
| 1743 | Germany | Berlin | La Stella Nera | 0 m from id=1492 'Futura Neapolitan Pizza' |
| 1744 | Germany | Berlin | Mamida | 0 m from id=1492 'Futura Neapolitan Pizza' |
| 1745 | Greece | Athens | Ma Che Vuoi | 0 m from id=1528 'Odori' |
| 1746 | Greece | Athens | Napul’è | 0 m from id=1528 'Odori' |
| 1747 | Greece | Athens | Ovio | 0 m from id=1528 'Odori' |
| 1748 | Hungary | Budapest | Digó | 0 m from id=1490 'Belli di Mamma' |
| 1749 | Hungary | Budapest | Forni di Napoli | 0 m from id=1490 'Belli di Mamma' |
| 1750 | Hungary | Budapest | Pizza Manufaktúra | 0 m from id=1490 'Belli di Mamma' |
| 1753 | Latvia | Riga | Bella Napoli | 0 m from id=1516 'PEPPO’s Pizzeria Contemporanea' |
| 1754 | Latvia | Riga | Street Pizza | 0 m from id=1516 'PEPPO’s Pizzeria Contemporanea' |
| 1761 | Poland | Warsaw | Mąka i Woda Żoliborz | 0 m from id=1530 'Ciao a Tutti' |
| 1762 | Poland | Warsaw | Melio | 0 m from id=1530 'Ciao a Tutti' |
| 1763 | Poland | Warsaw | Milo Pizza Napoletana | 0 m from id=1530 'Ciao a Tutti' |
| 1768 | Romania | Bucharest | PizzaMania | 0 m from id=1513 'Animaletto Pizza Bar' |
| 1771 | Slovakia | Bratislava | Da Alfonso | 0 m from id=1491 'Sapori Italiani U Taliana' |
| 1795 | Switzerland | Zurich | ARCADE | 0 m from id=1497 'da PONE' |
| 1796 | Switzerland | Zurich | Con Gusto | 0 m from id=1497 'da PONE' |
| 1797 | Switzerland | Zurich | Margherì | 0 m from id=1497 'da PONE' |
| 1798 | Switzerland | Zurich | NA081 | 0 m from id=1497 'da PONE' |
| 1800 | Switzerland | Zurich | Più | 0 m from id=1497 'da PONE' |
| 1801 | Switzerland | Geneva | Pizzeria Ciro | 0 m from id=1270 'Luigia' |
| 1804 | Netherlands | Amsterdam | DOPE | 0 m from id=1475 'nNea' |
| 1807 | Netherlands | Amsterdam | Pizza Project | 0 m from id=1475 'nNea' |
| 1811 | Latvia | Riga | PEPPO’s | 0 m from id=1516 'PEPPO’s Pizzeria Contemporanea' |
| 1813 | United States | Los Angeles | Pizzana | same name |
| 1814 | United States | Los Angeles | Quarter Sheets | 11 m from id=1097 'Quarter Sheets Pizza' |
| 1815 | United States | Miami Beach | Lucali | same name |
| 1816 | Italy | Naples | Da Concettina ai Tre Santi | 11 m from id=733 'Isabella De Cham' |
| 1817 | Italy | San Bonifacio | I Tigli | same name |
| 1818 | Italy | Naples | La Notizia 53 | 14 m from id=183 'La Notizia' |