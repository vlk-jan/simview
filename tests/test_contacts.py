import pytest

torch = pytest.importorskip("torch")

from simview.state import SimViewBodyState


@pytest.mark.parametrize("dtype", [torch.bool, torch.float32, torch.float64])
def test_contacts_from_mask(dtype):
    # Batch of 2, 3 candidate points. Non-zero entries become contact indices.
    mask = torch.tensor([[1, 0, 1], [0, 0, 0]]).to(dtype)
    assert SimViewBodyState._process_contacts(mask) == [[0, 2], []]


@pytest.mark.parametrize("dtype", [torch.int32, torch.int64])
def test_contacts_from_indices(dtype):
    idx = torch.tensor([[0, 2], [1, 1]], dtype=dtype)
    assert SimViewBodyState._process_contacts(idx) == [[0, 2], [1, 1]]


def test_contacts_list_of_lists_passthrough():
    assert SimViewBodyState._process_contacts([[0, 2], []]) == [[0, 2], []]


def test_unknown_optional_attribute_raises():
    pos = torch.zeros(2, 3)
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]] * 2)
    with pytest.raises(ValueError, match="Unknown optional attribute"):
        SimViewBodyState("Box", pos, quat, {"not_a_real_attr": torch.zeros(2, 3)})
