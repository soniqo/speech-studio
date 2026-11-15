import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("espeech_e2e", Path(__file__).resolve().parents[1] / "test_espeech_e2e.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class SpeechContentGateTests(unittest.TestCase):
    def test_stress_markup_and_punctuation_do_not_count_as_word_errors(self):
        self.assertEqual(runner.word_error_rate("Молок+о сто+ит на стол+е.", "Молоко стоит на столе!"), 0)

    def test_reference_carryover_is_an_error(self):
        self.assertEqual(runner.word_error_rate("Это короткая проверка.", "Дикой природы это короткая проверка."), 2 / 3)

    def test_missing_or_reordered_words_fail_even_with_the_same_vocabulary(self):
        self.assertEqual(runner.word_error_rate("Первое второе третье", ""), 1)
        self.assertGreater(runner.word_error_rate("Первое второе третье", "Третье второе первое"), 0.2)
