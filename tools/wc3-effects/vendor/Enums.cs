using System.Numerics;
using System.Text;

namespace Wc3ModelViewer.Core.Formats;

/// <summary>How a PopcornFX billboard faces the viewer. Values are PopcornFX v2's <c>EBillboardMode</c>.</summary>
public enum PopcornBillboardMode
{
    ScreenAligned = 0,
    ViewposAligned = 1,
    AxisAligned = 2,
    AxisAlignedSpheroid = 3,
    AxisAlignedCapsule = 4,
    PlaneAligned = 5,
}

/// <summary>How a PopcornFX layer blends. Values are PopcornFX v2's <c>ETransparentType</c>.</summary>
public enum PopcornBlend
{
    Additive = 0,
    AdditiveNoAlpha = 1,
    AlphaBlend = 2,
    PremultipliedAlpha = 3,
}
