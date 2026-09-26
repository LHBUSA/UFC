# Training & Corner enrichment — 2026-09-26 sprint

Priority set: 11 current champions, 165 top-15 entries and 54 fighters on the next 3 UFC cards, which is 218 distinct fighters. Built from the live rankings snapshot of 2026-09-26 and the `ufc_bouts_effective` cards.

## Pipeline (repeatable)
1. Research agents write candidate facts, each with a verbatim quote, source URL and publication date.
2. `scripts/training/verify_research.mjs` fetches each source itself and applies these checks:
   - allowed domain;
   - no Sherdog origin;
   - the quote is on the page;
   - the fighter surname and the coach, city or gym are on the page;
   - coach sources are 2023 or later and give the coach's surname.

   Place parts that are not on the page are dropped.
3. Human review of meaning. This sprint excluded 6 facts: Topuria's split article, the prior head coach of Saint Denis, a city inferred for Ulberg, Kuniev's past ATT stay, "spotted training" for Adesanya, and an EssentiallySports reprint for Yan.
4. `scripts/training/apply_verified.mjs` writes through `enrich.mjs`, with these rules:
   - research never creates camps;
   - a switch is applied only when its destination is the current camp;
   - a coach role of OTHER is dropped when a stated role exists.

   The apply step is idempotent: a re-run gave 0 new and 56 duplicates.

## Result
127 candidate facts gave 69 that passed the mechanical checks. After exclusions and 2 facts hand-verified with WebFetch (the sites block scripted fetches), **56 were applied**, covering 39 fighters.
Champions 4/11, top-15 34/165, next-3-card fighters 6/54. Named coach relationships: 39 (31 fighters). Training bases: 18. Fighting out of: 1. Confirmed switches: 2.

## Held for review (6)
- Loopy Godínez (switch): camp "Lobo Gym" has no exact match
- David Onama (switch): camp "Factory X" has no exact match
- Mauricio Ruffy (temporary_camp): camp "Freestyle MMA" has no exact match
- Eduarda Moura (switch): camp "Fight House" has no exact match
- Rodolfo Bellato (switch): switch to slug:american-top-team but current camp is slug:team-nogueira; review
- Gillian Robertson (switch): camp "GOAT Shed" has no exact match

## Not researched: the session's web-search cap (200) ran out (77)
Alatengheili, Alexander Hernandez, Alexander Volkov, Amanda Ribas, Andrey Pulyaev, Bernardo Sopaj, Brady Hiestand, Casey O'Neill, Court McGee, Damian Pinas, Denise Gomes, Eric Nolan, Fatima Kline, Gabriel Bonfim, Gabriella Fernandes, Gregory Rodrigues, Imanol Rodriguez, Ismael Bonfim, Jamahal Hill, Jan Blachowicz, Jasmine Jasudavicius, John Castaneda, Joselyne Edwards, Josh Hokit, Josiah Harrell, Kamaru Usman, King Green, Leon Edwards, Lerone Murphy, Lucas Armand, Marcus McGhee, Mario Bautista, Mario Pinto, Mateusz Gamrot, Mehemmedeli Osmanli, Melissa Amaya, Melissa Croden, Michael Morales, Michelle Montague, Mike Malott, Montel Jackson, Natalia Silva, Neil Magny, Nikita Krylov, Norma Dumont, Payton Talbott, Quillan Salkilld, Rafael Dos Anjos, Ramazan Temirov, Raoni Barcelos, Raul Rosas Jr., Regina Tarin, Rinya Nakamura, Robert Bryczek, Robert Whittaker, Rodolfo Vieira, Roman Kopylov, Rose Namajunas, Sean Brady, Sean O'Malley, Serghei Spivac, Shara Magomedov, Steve Garcia, Sumudaerji, Tagir Ulanbekov, Tatiana Suarez, Tim Elliott, Tyrell Fortune, Umar Nurmagomedov, Valesca Machado, Valter Walker, Vanessa Demopoulos, Virna Jandiroba, Waldo Cortes Acosta, Yana Santos, Yaroslav Amosov, Zhang Weili

## Searched, nothing verifiable (some only lightly after the cap) (69)
Abus Magomedov, Ailin Perez, Alden Coria, Alex Perez, Amanda Lemos, Amir Albazi, Angela Hill, Anthony Wint, Asu Almabayev, Azamat Murzakanov, Belal Muhammad, Beneil Dariush, Bogdan Guskov, Brian Ortega, Caio Borralho, Carlos Prates, Christian Edwards, Christian Leroy Duncan, Curtis Blaydes, Dan Hooker, Daniel Rodriguez, David Martinez, Deiveson Figueiredo, Diego Lopes, Elves Brener, Erin Blanchfield, Esteban Ribovics, Farid Basharat, Francisco Prado, Ilimbek Akylbek Uulu, Ismail Naurdiev, Jacqueline Cavalcanti, Jean Silva, Jessica Andrade, Joaquin Buckley, Julianna Pena, Karine Silva, Khaos Williams, Luana Santos, Luis Hernandez, Macy Chiasson, Marvin Vettori, Melquizael Costa, Mick Parkin, Miesha Tate, Mizuki, Movsar Evloev, Navajo Stirling, Nora Cornolle, Paddy Pimblett, Rafael Fiziev, Raquel Pennington, Renato Moicano, Ricky Simon, Roberto Soldić, Salahdine Parnasse, Sedriques Dumas, Sergei Pavlovich, Steve Erceg, Tabatha Ricci, Tom Aspinall, Tom Nolan, Uros Medic, Vitor Petrino, Wang Cong, Yair Rodriguez, Yan Xiaonan, Yazmin Jauregui, Youssef Zalal

Blocked outlets for scripted verification: Bloody Elbow (402), MMA Mania (403 at times), mmafighting.com and mmajunkie (partly). Items from those sources need a manual WebFetch check or a syndicated copy.
