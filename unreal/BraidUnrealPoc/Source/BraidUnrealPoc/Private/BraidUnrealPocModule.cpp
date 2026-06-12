#include "CoreMinimal.h"
#include "Framework/Docking/TabManager.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "SWebBrowser.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "BraidUnrealPoc"

namespace BraidUnrealPoc
{
static const FName TabName(TEXT("BraidUnrealPoc"));
}

class FBraidUnrealPocModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
            BraidUnrealPoc::TabName,
            FOnSpawnTab::CreateRaw(this, &FBraidUnrealPocModule::SpawnBraidTab))
            .SetDisplayName(LOCTEXT("TabTitle", "Braid"))
            .SetTooltipText(LOCTEXT("TabTooltip", "Open the Braid React canvas inside Unreal Editor."))
            .SetMenuType(ETabSpawnerMenuType::Hidden);

        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FBraidUnrealPocModule::RegisterMenus));
    }

    virtual void ShutdownModule() override
    {
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(BraidUnrealPoc::TabName);
    }

private:
    void RegisterMenus()
    {
        FToolMenuOwnerScoped OwnerScoped(this);
        UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
        FToolMenuSection& Section = Menu->FindOrAddSection(FName(TEXT("Braid")));

        Section.AddMenuEntry(
            FName(TEXT("OpenBraidUnrealPoc")),
            LOCTEXT("OpenMenuLabel", "Braid Canvas PoC"),
            LOCTEXT("OpenMenuTooltip", "Open the Braid React/React Flow canvas in an Unreal editor tab."),
            FSlateIcon(),
            FUIAction(FExecuteAction::CreateRaw(this, &FBraidUnrealPocModule::OpenBraidTab)));
    }

    void OpenBraidTab()
    {
        FGlobalTabmanager::Get()->TryInvokeTab(BraidUnrealPoc::TabName);
    }

    TSharedRef<SDockTab> SpawnBraidTab(const FSpawnTabArgs& SpawnTabArgs)
    {
        const FString InitialUrl = GetBraidUrl();

        return SNew(SDockTab)
            .TabRole(ETabRole::NomadTab)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot()
                .AutoHeight()
                [
                    SNew(SBorder)
                    .Padding(FMargin(8.0f, 6.0f))
                    [
                        SNew(STextBlock)
                        .Text(LOCTEXT("HeaderText", "Braid Unreal PoC: current Braid React Flow bundle, hosted by UE WebBrowser."))
                    ]
                ]
                + SVerticalBox::Slot()
                .FillHeight(1.0f)
                [
                    SNew(SWebBrowser)
                    .InitialURL(InitialUrl)
                    .ShowControls(false)
                    .ShowAddressBar(false)
                    .ShowErrorMessage(true)
                    .SupportsTransparency(false)
                    // UE's CEF runs windowless (off-screen) and repaints the page into a Slate texture.
                    // The SWebBrowser default is only 24 fps (SWebBrowser.h _BrowserFrameRate(24)); CEF
                    // clamps windowless OSR to 60 (WebBrowserSingleton MaxFrameRateClamp). Request 60 so
                    // the React Flow canvas repaints as smoothly as this host path allows.
                    .BrowserFrameRate(60)
                ]
            ];
    }

    FString GetBraidUrl() const
    {
        TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("BraidUnrealPoc"));
        const FString BaseDir = Plugin.IsValid()
            ? Plugin->GetBaseDir()
            : FPaths::Combine(FPaths::ProjectPluginsDir(), TEXT("BraidUnrealPoc"));

        FString IndexPath = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(BaseDir, TEXT("Resources"), TEXT("Web"), TEXT("index.html")));
        FPaths::NormalizeFilename(IndexPath);

        return FString::Printf(TEXT("file:///%s"), *IndexPath);
    }
};

IMPLEMENT_MODULE(FBraidUnrealPocModule, BraidUnrealPoc)

#undef LOCTEXT_NAMESPACE
