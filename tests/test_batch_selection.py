"""Tests for merge.py's batch-selector parsing (torch-free, so they also run on
a viewing-only base install -- the CLI reaches this code before anything
authoring-related)."""

import pytest

from simview.merge import parse_batch_selection, split_batch_spec


@pytest.mark.parametrize(
    "spec,expected",
    [
        ("scene.json", ("scene.json", None)),
        ("scene.json#1", ("scene.json", "1")),
        ("scene.json#0,2-3", ("scene.json", "0,2-3")),
        ("rci:~/runs/scene.json#-1", ("rci:~/runs/scene.json", "-1")),
        # Only the last '#' separates, so a '#' inside the path survives.
        ("odd#dir/scene.json#1", ("odd#dir/scene.json", "1")),
    ],
)
def test_split_batch_spec(spec, expected):
    assert split_batch_spec(spec) == expected


def test_split_batch_spec_prefers_an_existing_local_file(tmp_path):
    path = tmp_path / "odd#1.json"
    path.write_text("{}")
    assert split_batch_spec(str(path)) == (str(path), None)


@pytest.mark.parametrize("spec", ["scene.json#", "#1"])
def test_split_batch_spec_rejects_malformed_specs(spec):
    with pytest.raises(ValueError, match="Malformed batch selection"):
        split_batch_spec(spec)


@pytest.mark.parametrize(
    "selector,expected",
    [
        ("1", [1]),
        ("0,2", [0, 2]),
        (" 0 , 2 ", [0, 2]),
        ("1-3", [1, 2, 3]),
        ("-1", [3]),
        ("3,0", [3, 0]),
        ("0-1,3", [0, 1, 3]),
        ([2, 1], [2, 1]),
    ],
)
def test_parse_batch_selection(selector, expected):
    assert parse_batch_selection(selector, 4, None, "run.json") == expected


def test_parse_batch_selection_matches_batch_names():
    names = ["gt", "ours", "theirs"]
    assert parse_batch_selection("ours", 3, names, "run.json") == [1]
    assert parse_batch_selection("theirs,gt", 3, names, "run.json") == [2, 0]


def test_parse_batch_selection_prefers_indices_over_names():
    """A batch *named* '2' is still selected by index -- documented in
    parse_batch_selection, and the reason a name can be picked by index."""
    assert parse_batch_selection("2", 3, ["2", "1", "0"], "run.json") == [2]


def test_parse_batch_selection_rejects_an_ambiguous_name():
    with pytest.raises(ValueError, match="names 2 of its batches"):
        parse_batch_selection("dup", 3, ["dup", "dup", "x"], "run.json")


def test_parse_batch_selection_rejects_an_empty_index_sequence():
    with pytest.raises(ValueError, match="selection is empty"):
        parse_batch_selection([], 3, None, "run.json")
