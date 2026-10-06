"""Per-body visuals (color/opacity/visible) and model-level viewer_defaults."""

import pytest

pytest.importorskip("torch")

from conftest import build_scene

from simview.model import BodyShapeType, SimViewBody
from simview.scene import SimulationScene


def _box(**kw):
    return SimViewBody.create_box("b", 1, 1, 1, **kw)


def test_default_body_visuals_are_not_serialized():
    j = _box().to_json()
    assert not {"color", "opacity", "visible"} & j.keys()


def test_body_visuals_serialize_and_round_trip():
    body = _box(color=(1.0, 0.75, 0.0), opacity=0.5, visible=False)
    j = body.to_json()
    assert j["color"] == [1.0, 0.75, 0.0]
    assert j["opacity"] == 0.5
    assert j["visible"] is False
    assert SimViewBody.from_dict(j) == body


@pytest.mark.parametrize(
    "kw", [{"color": (1, 0)}, {"color": (0, 0, 2)}, {"opacity": 0}, {"opacity": 1.5}]
)
def test_invalid_body_visuals_raise(kw):
    with pytest.raises(ValueError):
        _box(**kw)


def test_create_body_passes_visuals_without_leaking_into_shape():
    scene = build_scene()
    scene.create_body(
        "Amber",
        BodyShapeType.SPHERE,
        radius=0.1,
        color=[1.0, 0.7, 0.0],
        opacity=0.4,
    )
    body = scene.model.bodies["Amber"]
    assert body.color == [1.0, 0.7, 0.0]
    assert body.opacity == 0.4
    assert set(body.shape) == {"type", "radius"}


def test_viewer_defaults_round_trip_through_save_and_load(tmp_path):
    scene = build_scene()
    assert "viewerDefaults" not in scene.model.to_json()
    defaults = {"ui": {"pointCloudsVisible": False}, "folders": {"Scene Info": False}}
    scene.model.viewer_defaults = defaults
    assert scene.model.to_json()["viewerDefaults"] == defaults
    out = tmp_path / "s.json"
    scene.save(out)
    assert SimulationScene.load(out).model.viewer_defaults == defaults


def test_viewer_defaults_constructor_and_validation():
    s = SimulationScene(
        batch_size=1, scalar_names=[], dt=0.1, viewer_defaults={"bodyStatesOpen": False}
    )
    assert s.model.viewer_defaults == {"bodyStatesOpen": False}
    with pytest.raises(ValueError):
        SimulationScene(
            batch_size=1, scalar_names=[], dt=0.1, viewer_defaults={"x": {1}}
        )
    with pytest.raises(ValueError):
        SimulationScene(batch_size=1, scalar_names=[], dt=0.1, viewer_defaults=[1])  # type: ignore[arg-type]
