"""What a segment is, in the words of a terminology (SNOMED CT and the rest).

A segment carries a terminology entry as a tag: the category it belongs to ("Tissue"), the type it
is ("Liver"), and where called for a modifier of that type ("left"). Slicer keeps the entry as one
string on the segment, names the segment after it and colours it by the colour the terminology
recommends - so that a liver is the same colour in every scene, and so that what a segment means
survives being sent somewhere else.

The lists offered here come from the terminologies the application loaded (the Terminologies
module), through its logic, which is also what writes the entry back onto the segment.
"""

import logging

import slicer
import vtk

from . import host
from .bridge import method

logger = logging.getLogger("slicerweb.terminology")


def _logic():
    logic = slicer.app.applicationLogic().GetModuleLogic("Terminologies")
    if logic is None:
        raise RuntimeError("The Terminologies module is not loaded")
    return logic


def _loadedNames():
    names = vtk.vtkStringArray()
    _logic().GetLoadedTerminologyNames(names)
    return [names.GetValue(i) for i in range(names.GetNumberOfValues())]


def _defaultTerminology(terminologyName=None):
    names = _loadedNames()
    if terminologyName and terminologyName in names:
        return terminologyName
    return names[0] if names else ""


def _colorOf(codedEntry):
    """The colour a terminology recommends for something, as the page writes colours."""
    rgb = codedEntry.GetRecommendedDisplayRGBValue()
    return "#%02x%02x%02x" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def _matches(text, search):
    return not search or search.lower() in (text or "").lower()


def _category(terminologyName, codeValue):
    """The category of a terminology with this code, or None."""
    logic = _logic()
    category = slicer.vtkSlicerTerminologyCategory()
    for index in range(logic.GetNumberOfCategoriesInTerminology(terminologyName)):
        logic.GetNthCategoryInTerminology(terminologyName, index, category)
        if category.GetCodeValue() == codeValue:
            found = slicer.vtkSlicerTerminologyCategory()
            found.Copy(category)
            return found
    return None


def _type(terminologyName, category, codeValue):
    """The type in a category with this code, or None."""
    logic = _logic()
    typeObject = slicer.vtkSlicerTerminologyType()
    for index in range(logic.GetNumberOfTypesInTerminologyCategory(terminologyName, category)):
        logic.GetNthTypeInTerminologyCategory(terminologyName, category, index, typeObject)
        if typeObject.GetCodeValue() == codeValue:
            found = slicer.vtkSlicerTerminologyType()
            found.Copy(typeObject)
            return found
    return None


def _modifier(terminologyName, category, typeObject, codeValue):
    """The modifier of a type with this code, or None."""
    logic = _logic()
    modifier = slicer.vtkSlicerTerminologyType()
    for index in range(logic.GetNumberOfTypeModifiersInTerminologyType(terminologyName, category, typeObject)):
        logic.GetNthTypeModifierInTerminologyType(terminologyName, category, typeObject, index, modifier)
        if modifier.GetCodeValue() == codeValue:
            found = slicer.vtkSlicerTerminologyType()
            found.Copy(modifier)
            return found
    return None


def _segment(segmentationNodeID, segmentID):
    node = slicer.mrmlScene.GetNodeByID(segmentationNodeID or "")
    segment = node.GetSegmentation().GetSegment(segmentID) if node is not None else None
    if segment is None:
        raise RuntimeError("No such segment: %s" % segmentID)
    return node, segment


# ------------------------------------------------------------------ what there is to choose from
@method()
def terminologyNames():
    """The terminologies the application has loaded."""
    return _loadedNames()


@method()
def terminologyCategoryList(terminologyName=None, search=""):
    """The categories of a terminology: Tissue, Morphologically Altered Structure, and so on."""
    logic = _logic()
    terminologyName = _defaultTerminology(terminologyName)
    category = slicer.vtkSlicerTerminologyCategory()
    result = []
    for index in range(logic.GetNumberOfCategoriesInTerminology(terminologyName)):
        logic.GetNthCategoryInTerminology(terminologyName, index, category)
        if _matches(category.GetCodeMeaning(), search):
            result.append({"codeValue": category.GetCodeValue(), "name": category.GetCodeMeaning()})
    return result


@method()
def terminologyTypeList(terminologyName, categoryCodeValue, search=""):
    """The types in a category: what a segment can be said to be."""
    logic = _logic()
    terminologyName = _defaultTerminology(terminologyName)
    category = _category(terminologyName, categoryCodeValue)
    if category is None:
        return []
    typeObject = slicer.vtkSlicerTerminologyType()
    result = []
    for index in range(logic.GetNumberOfTypesInTerminologyCategory(terminologyName, category)):
        logic.GetNthTypeInTerminologyCategory(terminologyName, category, index, typeObject)
        if not _matches(typeObject.GetCodeMeaning(), search):
            continue
        result.append({
            "codeValue": typeObject.GetCodeValue(),
            "name": typeObject.GetCodeMeaning(),
            "color": _colorOf(typeObject),
            "modifierCount": logic.GetNumberOfTypeModifiersInTerminologyType(terminologyName, category, typeObject),
        })
    return result


@method()
def terminologyModifierList(terminologyName, categoryCodeValue, typeCodeValue):
    """The modifiers a type offers, where it has any: left and right, for one."""
    logic = _logic()
    terminologyName = _defaultTerminology(terminologyName)
    category = _category(terminologyName, categoryCodeValue)
    typeObject = _type(terminologyName, category, typeCodeValue) if category is not None else None
    if typeObject is None:
        return []
    modifier = slicer.vtkSlicerTerminologyType()
    result = []
    for index in range(logic.GetNumberOfTypeModifiersInTerminologyType(terminologyName, category, typeObject)):
        logic.GetNthTypeModifierInTerminologyType(terminologyName, category, typeObject, index, modifier)
        result.append({"codeValue": modifier.GetCodeValue(), "name": modifier.GetCodeMeaning(),
                       "color": _colorOf(modifier)})
    return result


# ------------------------------------------------------------------ what a segment says it is
@method()
def getSegmentTerminology(segmentationNodeID, segmentID):
    """What the segment says it is, as far as it says anything."""
    logic = _logic()
    _, segment = _segment(segmentationNodeID, segmentID)
    entry = slicer.vtkSlicerTerminologyEntry()
    # The tag is handed back through the argument, as it is in C++
    serialized = vtk.reference("")
    segment.GetTag(slicer.vtkSegment.GetTerminologyEntryTagName(), serialized)
    serialized = str(serialized)
    answer = {"name": segment.GetName(),
              "color": "#%02x%02x%02x" % tuple(int(c * 255 + 0.5) for c in segment.GetColor()),
              "terminologyName": _defaultTerminology(None),
              "categoryCodeValue": "", "typeCodeValue": "", "modifierCodeValue": "", "description": ""}
    if not serialized or not logic.DeserializeTerminologyEntry(serialized, entry):
        return answer
    answer["terminologyName"] = entry.GetTerminologyContextName() or answer["terminologyName"]
    answer["categoryCodeValue"] = entry.GetCategoryObject().GetCodeValue() or ""
    answer["typeCodeValue"] = entry.GetTypeObject().GetCodeValue() or ""
    answer["modifierCodeValue"] = entry.GetTypeModifierObject().GetCodeValue() or ""
    answer["description"] = logic.GetInfoStringFromTerminologyEntry(entry)
    return answer


@method()
def setSegmentTerminology(segmentationNodeID, segmentID, terminologyName, categoryCodeValue,
                          typeCodeValue, modifierCodeValue=""):
    """Say what a segment is, and take its name and colour from that.

    The same as choosing a terminology in the desktop Segment Editor: the entry is written onto the
    segment as its tag, the segment is named after the type (or its modifier, where one is chosen)
    and coloured as the terminology recommends.
    """
    logic = _logic()
    node, segment = _segment(segmentationNodeID, segmentID)
    terminologyName = _defaultTerminology(terminologyName)
    category = _category(terminologyName, categoryCodeValue)
    if category is None:
        raise RuntimeError("No such category: %s" % categoryCodeValue)
    typeObject = _type(terminologyName, category, typeCodeValue)
    if typeObject is None:
        raise RuntimeError("No such type: %s" % typeCodeValue)
    modifier = _modifier(terminologyName, category, typeObject, modifierCodeValue) if modifierCodeValue else None

    entry = slicer.vtkSlicerTerminologyEntry()
    entry.SetTerminologyContextName(terminologyName)
    entry.GetCategoryObject().Copy(category)
    entry.GetTypeObject().Copy(typeObject)
    if modifier is not None:
        entry.GetTypeModifierObject().Copy(modifier)
    segment.SetTag(slicer.vtkSegment.GetTerminologyEntryTagName(), logic.SerializeTerminologyEntry(entry))

    named = modifier if modifier is not None else typeObject
    segment.SetName(named.GetCodeMeaning())
    segment.SetNameAutoGenerated(True)
    rgb = named.GetRecommendedDisplayRGBValue()
    segment.SetColor(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)
    segment.SetColorAutoGenerated(True)
    node.GetSegmentation().Modified()
    node.Modified()

    host.emit("segment-editor-changed", None)
    return getSegmentTerminology(segmentationNodeID, segmentID)
