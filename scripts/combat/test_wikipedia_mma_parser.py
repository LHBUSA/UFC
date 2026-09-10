import unittest

from wikipedia_mma_parser import normalize_name, parse_mma_record, promotion_guess


FIXTURE = r'''
<html><body>
<table class="infobox"><tr><td><span class="bday">1990-07-02</span></td></tr></table>
<h2>Mixed martial arts record</h2>
<table class="wikitable" id="mma-record">
<tr><th>Res.</th><th>Record</th><th>Opponent</th><th>Method</th><th>Event</th><th>Date</th><th>Round</th><th>Time</th><th>Location</th><th>Notes</th></tr>
<tr><td>Win</td><td>18–1</td><td><a href="/wiki/Holly_Holm">Holly Holm</a></td><td>Submission (rear-naked choke)</td><td><a href="/wiki/UFC_300">UFC 300</a></td><td><span style="display:none">2024-04-13</span>April 13, 2024</td><td>2</td><td>3:06</td><td>Las Vegas, Nevada, United States</td><td></td></tr>
<tr><td>Win</td><td>17–1</td><td><a href="/wiki/Aspen_Ladd">Aspen Ladd</a></td><td>Decision (unanimous)</td><td><a href="/wiki/2023_Professional_Fighters_League_season">PFL 10</a></td><td><time datetime="2023-11-24">November 24, 2023</time></td><td>5</td><td>5:00</td><td>Washington, D.C., United States</td><td>Catchweight bout</td></tr>
<tr><td>Loss</td><td>16–1</td><td><a href="/wiki/Larissa_Pacheco">Larissa Pacheco</a></td><td>Decision (unanimous)</td><td>PFL 10</td><td>November 25, 2022</td><td>5</td><td>5:00</td><td>New York City, New York, United States</td><td></td></tr>
</table>
<h2>Kickboxing record</h2>
<table class="wikitable" id="larger-wrong-sport">
<tr><th>Res.</th><th>Record</th><th>Opponent</th><th>Method</th><th>Event</th><th>Date</th><th>Round</th><th>Time</th><th>Location</th></tr>
<tr><td>Win</td><td>1–0</td><td>Wrong Sport 1</td><td>Decision</td><td>Glory 1</td><td>January 1, 2020</td><td>3</td><td>3:00</td><td>Tokyo</td></tr>
<tr><td>Win</td><td>2–0</td><td>Wrong Sport 2</td><td>Decision</td><td>Glory 2</td><td>January 1, 2021</td><td>3</td><td>3:00</td><td>Tokyo</td></tr>
<tr><td>Win</td><td>3–0</td><td>Wrong Sport 3</td><td>Decision</td><td>Glory 3</td><td>January 1, 2022</td><td>3</td><td>3:00</td><td>Tokyo</td></tr>
<tr><td>Win</td><td>4–0</td><td>Wrong Sport 4</td><td>Decision</td><td>Glory 4</td><td>January 1, 2023</td><td>3</td><td>3:00</td><td>Tokyo</td></tr>
</table>
</body></html>
'''


class WikipediaMmaParserTests(unittest.TestCase):
    def test_normalizer_matches_expected_identity_shape(self):
        self.assertEqual(normalize_name("Joanna Jędrzejczyk"), "joanna jedrzejczyk")
        self.assertEqual(normalize_name("O'Malley"), "omalley")

    def test_record_table(self):
        parsed = parse_mma_record(FIXTURE)
        self.assertEqual(parsed["dob"], "1990-07-02")
        self.assertEqual(len(parsed["rows"]), 3)
        self.assertNotIn("Wrong Sport 1", [r["opponent"] for r in parsed["rows"]])

        ufc = parsed["rows"][0]
        self.assertEqual(ufc["result"], "win")
        self.assertEqual(ufc["opponent"], "Holly Holm")
        self.assertEqual(ufc["opponent_wiki_title"], "Holly Holm")
        self.assertEqual(ufc["event_wiki_title"], "UFC 300")
        self.assertEqual(ufc["promotion_slug"], "ufc")
        self.assertEqual(ufc["method"], "SUB")
        self.assertEqual(ufc["round"], 2)
        self.assertEqual(ufc["time_sec"], 186)

        pfl = parsed["rows"][1]
        self.assertEqual(pfl["promotion_slug"], "pfl")
        self.assertEqual(pfl["method"], "DEC_U")
        self.assertEqual(pfl["event_date"], "2023-11-24")

    def test_promotion_guesses(self):
        self.assertEqual(promotion_guess("Bellator 271")[0], "bellator")
        self.assertEqual(promotion_guess("KSW 102")[0], "ksw")
        self.assertEqual(promotion_guess("ONE Championship 168")[0], "one")
        self.assertEqual(promotion_guess("Rizin 49")[0], "rizin")


if __name__ == "__main__":
    unittest.main()
